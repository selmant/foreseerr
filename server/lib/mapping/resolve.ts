import type TheMovieDb from '@server/api/themoviedb';
import type { MappingResolution } from '@server/entity/MappingResolution';
import logger from '@server/logger';
import {
  datasetsLoading,
  ensureMappingLayer,
  onDatasetsChanged,
} from './datasets';
import { deriveTmdb, type AnimeHints, type DeriveDeps } from './derive';
import { datasetTmdb } from './edges';
import { BoundedLru } from './lru';
import {
  GUESS_ORIGINS,
  correctionFor,
  deleteResolutions,
  invalidateCorrections,
  saveResolution,
  storedFor,
  type Correction,
} from './resolutions';
import { tmdbFind } from './tmdb';
import {
  refKey,
  type IdRef,
  type MappingOrigin,
  type MediaType,
} from './types';

export interface ResolveRequest {
  /** Every id the source supplied for the item, most reliable first. */
  refs: IdRef[];
  /**
   * The id the item is filed under in the unmapped list and in corrections,
   * e.g. its Trakt slug. Defaults to the first of `refs`.
   */
  identity?: IdRef;
  /** What the source says the item is. Never inferred from a TMDB response. */
  mediaType?: MediaType;
  title?: string;
  year?: number;
  discoverSource?: string;
  /** Present for anime, and what allows the title and prequel fallback. */
  anime?: AnimeHints;
  /** Stay off the network: datasets and stored answers only. */
  offline?: boolean;
  /** Test seams. */
  tmdb?: TheMovieDb;
  derive?: Partial<DeriveDeps>;
}

export interface TmdbResolution {
  tmdbId: number;
  mediaType: MediaType;
  origin: MappingOrigin;
  /** Set when the source id is one season of the show. */
  season?: number;
}

const ANIME_ENTRY = new Set<string>(['anilist', 'mal', 'anidb']);

/** How long a miss stands before the network steps are tried again. */
const MISS_TTL_MSEC = 12 * 3600 * 1000;

const hot = new BoundedLru<string, { value?: TmdbResolution }>(
  20_000,
  15 * 60 * 1000
);
/**
 * Lookups that failed on a network error. Nothing is stored for them, so this
 * is what keeps an outage or a rate limit from being retried on every render.
 */
const failed = new BoundedLru<string, true>(20_000, 2 * 60 * 1000);
onDatasetsChanged(() => hot.clear());

/** Drop cached answers, after a correction or a dataset change. */
export const invalidateResolutions = (): void => {
  hot.clear();
  failed.clear();
  invalidateCorrections();
};

/** A correction as an answer; undefined when it records "no TMDB entry". */
export const correctionAnswer = (
  correction: Correction
): TmdbResolution | undefined =>
  correction.tmdbId && correction.tmdbType
    ? {
        tmdbId: correction.tmdbId,
        mediaType: correction.tmdbType,
        origin: 'manual',
      }
    : undefined;

const fromRow = (row: MappingResolution): TmdbResolution | undefined =>
  row.tmdbId && row.tmdbType && row.origin !== 'miss'
    ? { tmdbId: row.tmdbId, mediaType: row.tmdbType, origin: row.origin }
    : undefined;

/** A stored row answers a request of its own declared type, or any if it has none. */
const applies = (row: MappingResolution, mediaType?: MediaType): boolean =>
  row.mediaType === '' || row.mediaType === (mediaType ?? '');

async function viaFind(
  request: ResolveRequest
): Promise<{ ref: IdRef; tmdbId: number; mediaType: MediaType } | undefined> {
  for (const ref of request.refs) {
    const source =
      ref.ns === 'imdb' ? 'imdb' : ref.ns === 'tvdb_show' ? 'tvdb' : undefined;
    if (!source) continue;
    // Asking TMDB for a movie by TVDB id is documented not to work.
    if (source === 'tvdb' && request.mediaType === 'movie') continue;
    const found = await tmdbFind(source, String(ref.id), request.tmdb);
    const candidates: [MediaType, number[]][] =
      request.mediaType === 'movie'
        ? [['movie', found.movies]]
        : request.mediaType === 'tv'
          ? [['tv', found.shows]]
          : [
              ['movie', found.movies],
              ['tv', found.shows],
            ];
    const answers = candidates.flatMap(([mediaType, ids]) =>
      ids.map((tmdbId) => ({ ref, tmdbId, mediaType }))
    );
    // Several records for one id is a split or a duplicate, not an answer.
    if (answers.length === 1) return answers[0];
  }
  return undefined;
}

async function resolveUncached(
  request: ResolveRequest
): Promise<TmdbResolution | undefined> {
  const { refs, mediaType } = request;
  const primary = request.identity ?? refs[0];

  // 1. An admin's correction, including "this has no TMDB counterpart".
  const correction = await correctionFor(refs);
  if (correction) return correctionAnswer(correction);

  const stored = (await storedFor(refs)).filter((row) =>
    applies(row, mediaType)
  );

  const misses = stored.filter((row) => row.origin === 'miss');
  const answered = async (
    answer: TmdbResolution,
    superseded: MappingResolution[] = []
  ): Promise<TmdbResolution> => {
    // The item is no longer unmapped, whichever of its ids the miss was under.
    const stale = [...misses, ...superseded];
    if (stale.length) await deleteResolutions(stale.map((row) => row.id));
    return answer;
  };

  // 2. What the datasets state. A guess made before they knew is now moot.
  for (const ref of refs) {
    const known = await datasetTmdb(ref, mediaType, { crossType: true });
    if (known) {
      return answered(
        { ...known, origin: 'dataset' },
        stored.filter((row) => GUESS_ORIGINS.includes(row.origin))
      );
    }
  }

  // 3. An answer worked out earlier.
  for (const ref of refs) {
    const row = stored.find(
      (candidate) =>
        candidate.srcNs === ref.ns &&
        candidate.srcId === String(ref.id) &&
        candidate.origin !== 'miss'
    );
    const answer = row && fromRow(row);
    // A stored lookup must not turn a declared movie into a show or back; only
    // a dataset edge or a correction may say the source's type is wrong.
    if (answer && (!mediaType || answer.mediaType === mediaType)) {
      return answered(answer);
    }
  }

  const context = {
    mediaType,
    title: request.title,
    year: request.year,
    discoverSource: request.discoverSource,
  };
  const recentMiss = misses.some(
    (row) => Date.now() - new Date(row.checkedAt).getTime() < MISS_TTL_MSEC
  );
  // While the datasets download for the first time, wait for them rather than
  // guessing or recording misses they are about to answer.
  if (request.offline || recentMiss || datasetsLoading()) return undefined;

  // 4. TMDB's own index of IMDb and TVDB ids.
  const found = await viaFind(request);
  if (found) {
    await saveResolution({
      ref: found.ref,
      ...context,
      tmdbId: found.tmdbId,
      tmdbType: found.mediaType,
      origin: 'tmdb-find',
    });
    return answered({
      tmdbId: found.tmdbId,
      mediaType: found.mediaType,
      origin: 'tmdb-find',
    });
  }

  // 5. For anime nothing knows yet: exact title, then the prequel's show.
  if (request.anime && mediaType) {
    const { anilistId } = request.anime;
    const derived = await deriveTmdb(
      {
        ...request.anime,
        titles: request.anime.titles ?? (request.title ? [request.title] : []),
        year: request.anime.year ?? request.year,
      },
      mediaType,
      request.derive
    );
    if (derived) {
      await saveResolution({
        // Filed under the AniList id when there is one, so every source that
        // carries the same entry reuses the answer.
        ref: anilistId ? { ns: 'anilist', id: String(anilistId) } : primary,
        ...context,
        tmdbId: derived.tmdbId,
        tmdbType: derived.mediaType,
        origin: derived.origin,
        detail: derived.detail,
      });
      return answered({
        tmdbId: derived.tmdbId,
        mediaType: derived.mediaType,
        origin: derived.origin,
      });
    }
  }

  // 6. Nothing answered. Remember that, so the next render does not repeat the
  // lookups. Sightings are counted by the discover routes, not here.
  await saveResolution({
    ref: primary,
    ...context,
    origin: 'miss',
    // An anime id asked about without its titles has not had the fallback
    // tried, so it must not hold back a caller that does have them.
    attempted:
      Boolean(request.anime) || !refs.some((ref) => ANIME_ENTRY.has(ref.ns)),
  });
  return undefined;
}

/**
 * Turn a source item's ids into a TMDB id.
 *
 * A fixed order, first answer wins: manual correction, dataset edge, stored
 * answer, TMDB `/find`, then the anime fallback. There is no scoring: the
 * datasets descend from the same curated data, so weighing them against each
 * other only ever measured how often a fact was copied.
 */
export async function resolveTmdb(
  request: ResolveRequest
): Promise<TmdbResolution | undefined> {
  const seen = new Set<string>();
  const refs = [request.identity, ...request.refs].filter(
    (ref): ref is IdRef =>
      Boolean(ref?.ns && ref.id) &&
      !seen.has(refKey(ref as IdRef)) &&
      Boolean(seen.add(refKey(ref as IdRef)))
  );
  if (!refs.length) return undefined;
  await ensureMappingLayer();

  const key = [
    refs.map(refKey).join(','),
    request.mediaType ?? '',
    request.offline ? 'offline' : '',
    request.anime ? 'anime' : '',
  ].join('|');
  const cached = hot.get(key);
  if (cached) return cached.value;
  if (failed.get(key)) return undefined;

  try {
    const value = await resolveUncached({ ...request, refs });
    hot.set(key, { value });
    return value;
  } catch (error) {
    // A transient failure must not be stored as "no such mapping"; it is only
    // held off for a couple of minutes.
    failed.set(key, true);
    logger.debug('Mapping lookup failed', {
      label: 'Mapping',
      refs: refs.map(refKey),
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** Whether an answer is an inference the settings page lists for review. */
export const isGuess = (origin: MappingOrigin): boolean =>
  (GUESS_ORIGINS as string[]).includes(origin);
