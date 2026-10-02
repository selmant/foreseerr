import AnilistAPI, { AnilistGraphQLError } from '@server/api/anilist';
import type {
  AnilistMedia,
  AnilistRelationEdge,
} from '@server/api/anilist/interfaces';
import TheMovieDb from '@server/api/themoviedb';
import axios from 'axios';
import { datasetTmdb } from './edges';
import type { MediaType } from './types';

/**
 * Work out a TMDB id for an anime no dataset knows yet.
 *
 * Datasets cover the back catalogue but trail new releases by weeks, and every
 * id-based service trails with them. Two rules close most of that gap:
 *
 *  A. An exact title match on TMDB, same year, Animation genre.
 *  B. For a later season, the show its prequel maps to.
 *
 * Measured against 963 titles with a known answer: 95% answered, 98.5% of
 * those correct. The result is stored as a guess and yields to a dataset edge
 * as soon as one exists.
 */

export interface AnimeHints {
  anilistId?: number;
  /** Titles to try, most specific first: native, romaji, English. */
  titles?: string[];
  year?: number;
  format?: string | null;
  /** Relation links when the caller already has them; saves an AniList call. */
  relations?: AnilistRelationEdge[] | null;
}

export interface DerivedTmdb {
  tmdbId: number;
  mediaType: MediaType;
  origin: 'title' | 'prequel';
  detail: string;
}

export interface TitleHit {
  id: number;
  name?: string;
  originalName?: string;
  year?: number;
  genreIds: number[];
}

export interface DeriveDeps {
  search: (mediaType: MediaType, query: string) => Promise<TitleHit[]>;
  anilistMedia: (anilistId: number) => Promise<AnilistMedia | null>;
}

const ANIMATION_GENRE = 16;
const SERIES_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA']);
const MAX_TITLES = 3;
const MAX_PREQUEL_HOPS = 6;
// Each hop past the first costs an AniList request at one per second.
const MAX_RELATION_FETCHES = 3;

const yearOf = (date?: string): number | undefined => {
  const year = Number(date?.slice(0, 4));
  return Number.isFinite(year) && year > 1870 ? year : undefined;
};

export const tmdbTitleSearch = (
  tmdb: TheMovieDb = new TheMovieDb()
): DeriveDeps['search'] =>
  async function search(mediaType, query) {
    if (mediaType === 'movie') {
      const { results } = await tmdb.searchMovies({
        query,
        includeAdult: true,
      });
      return results.map((result) => ({
        id: result.id,
        name: result.title,
        originalName: result.original_title,
        year: yearOf(result.release_date),
        genreIds: result.genre_ids ?? [],
      }));
    }
    const { results } = await tmdb.searchTvShows({ query, includeAdult: true });
    return results.map((result) => ({
      id: result.id,
      name: result.name,
      originalName: result.original_name,
      year: yearOf(result.first_air_date),
      genreIds: result.genre_ids ?? [],
    }));
  };

/**
 * One client for every fallback lookup, so its one-request-a-second limiter
 * covers all of them rather than each getting its own.
 */
let sharedAnilist: AnilistAPI | undefined;

/**
 * An AniList entry with its relations, or null when AniList has no such entry.
 * Rate limits and outages are thrown: a guess made without the relations would
 * be stored as a miss for hours.
 */
async function anilistMediaOrNull(
  anilistId: number
): Promise<AnilistMedia | null> {
  sharedAnilist ??= new AnilistAPI();
  try {
    return await sharedAnilist.getMediaWithRelations(anilistId);
  } catch (error) {
    const notFound =
      error instanceof AnilistGraphQLError ||
      (axios.isAxiosError(error) && error.response?.status === 404);
    if (notFound) return null;
    throw error;
  }
}

const defaultDeps = (): DeriveDeps => ({
  search: tmdbTitleSearch(),
  anilistMedia: anilistMediaOrNull,
});

/**
 * Letters and digits only, so `SAKAMOTO DAYS` equals `Sakamoto Days` and
 * punctuation or spacing differences between catalogues do not matter. Works on
 * Japanese titles, which is where the match is most reliable.
 */
export const titleKey = (value?: string | null): string =>
  (value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Rule A. Equality, not similarity: a near match between two anime is the
 * normal case for a franchise, and is exactly what produced wrong posters.
 */
async function byExactTitle(
  hints: AnimeHints,
  mediaType: MediaType,
  search: DeriveDeps['search']
): Promise<DerivedTmdb | undefined> {
  // Without a year there is nothing to tell a remake from the original.
  if (!hints.year) return undefined;
  const titles = [...new Set((hints.titles ?? []).filter((t) => t?.trim()))];

  for (const title of titles.slice(0, MAX_TITLES)) {
    const wanted = titleKey(title);
    if (!wanted) continue;
    const hits = (await search(mediaType, title)).filter(
      (hit) =>
        (titleKey(hit.name) === wanted ||
          titleKey(hit.originalName) === wanted) &&
        hit.year !== undefined &&
        Math.abs(hit.year - (hints.year as number)) <= 1 &&
        hit.genreIds.includes(ANIMATION_GENRE)
    );
    if (hits.length === 1) {
      return {
        tmdbId: hits[0].id,
        mediaType,
        origin: 'title',
        detail: `"${title}" (${hits[0].year})`,
      };
    }
    // Two exact matches cannot be told apart by trying another spelling.
    if (hits.length > 1) return undefined;
  }
  return undefined;
}

const prequelsOf = (
  relations?: AnilistRelationEdge[] | null
): { id: number; format?: string | null }[] =>
  (relations ?? []).flatMap((edge) =>
    edge?.relationType === 'PREQUEL' &&
    edge.node?.id &&
    (edge.node.type ?? 'ANIME') === 'ANIME'
      ? [{ id: edge.node.id, format: edge.node.format }]
      : []
  );

/**
 * Rule B. A new season is filed on TMDB under the show it continues, so the
 * nearest prequel with a known show answers for it.
 */
async function byPrequel(
  hints: AnimeHints,
  anilistMedia: DeriveDeps['anilistMedia']
): Promise<DerivedTmdb | undefined> {
  let frontier = prequelsOf(hints.relations);
  const seen = new Set<number>(hints.anilistId ? [hints.anilistId] : []);
  let fetches = 0;

  for (let hop = 0; hop < MAX_PREQUEL_HOPS && frontier.length; hop += 1) {
    const next: typeof frontier = [];
    for (const prequel of frontier) {
      if (seen.has(prequel.id)) continue;
      seen.add(prequel.id);
      // A film or special before the series is not the series.
      if (!prequel.format || !SERIES_FORMATS.has(prequel.format)) continue;
      const known = await datasetTmdb(
        { ns: 'anilist', id: String(prequel.id) },
        'tv'
      );
      if (known) {
        return {
          tmdbId: known.tmdbId,
          mediaType: 'tv',
          origin: 'prequel',
          detail: `prequel anilist:${prequel.id}`,
        };
      }
      if (fetches >= MAX_RELATION_FETCHES) continue;
      fetches += 1;
      next.push(
        ...prequelsOf((await anilistMedia(prequel.id))?.relations?.edges)
      );
    }
    frontier = next;
  }
  return undefined;
}

/**
 * Rule A, then rule B. A runs first so a sequel TMDB files as its own show
 * (Naruto Shippuden) is found by name before B would hand it the parent.
 *
 * AniList is only asked when the caller's own titles did not match and its
 * relation links are needed, so a discover page that already carries them
 * costs no extra request.
 */
export async function deriveTmdb(
  hints: AnimeHints,
  mediaType: MediaType,
  deps: Partial<DeriveDeps> = {}
): Promise<DerivedTmdb | undefined> {
  const { search, anilistMedia } = { ...defaultDeps(), ...deps };

  const titled = await byExactTitle(hints, mediaType, search);
  if (titled) return titled;

  let known = hints;
  if (hints.anilistId && hints.relations === undefined) {
    const media = await anilistMedia(hints.anilistId);
    if (media) {
      // Without a year rule A searched nothing, so every title is still open.
      const tried = new Set(
        hints.year ? (hints.titles ?? []).map(titleKey) : []
      );
      // AniList's spellings are the ones TMDB matches best; the caller may
      // only have had another catalogue's.
      const fresh = [
        media.title?.native,
        media.title?.romaji,
        media.title?.english,
        ...(hints.titles ?? []),
      ].filter((title): title is string => {
        const key = titleKey(title);
        if (!key || tried.has(key)) return false;
        tried.add(key);
        return true;
      });
      known = {
        ...hints,
        titles: fresh,
        year: media.startDate?.year ?? media.seasonYear ?? hints.year,
        format: media.format ?? hints.format,
        relations: media.relations?.edges ?? [],
      };
      const retitled = fresh.length
        ? await byExactTitle(known, mediaType, search)
        : undefined;
      if (retitled) return retitled;
    }
  }

  const isSeries =
    mediaType === 'tv' && (!known.format || SERIES_FORMATS.has(known.format));
  return isSeries ? byPrequel(known, anilistMedia) : undefined;
}
