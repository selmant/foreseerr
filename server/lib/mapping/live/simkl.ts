import SimklAPI from '@server/api/simkl';
import {
  cacheNegative,
  isNegativelyCached,
  tripCircuit,
  withBudget,
} from '@server/lib/mapping/budget';
import type {
  IdRef,
  MappingCandidate,
  MappingResolver,
  Namespace,
} from '@server/lib/mapping/types';
import logger from '@server/logger';
import axios from 'axios';

const REDIRECT_SOURCE: Partial<
  Record<
    Namespace,
    'anidb' | 'anilist' | 'mal' | 'kitsu' | 'imdb' | 'tvdb' | 'tmdb'
  >
> = {
  anidb: 'anidb',
  anilist: 'anilist',
  mal: 'mal',
  kitsu: 'kitsu',
  imdb: 'imdb',
  tvdb_show: 'tvdb',
  tmdb_show: 'tmdb',
  tmdb_movie: 'tmdb',
};

/** Which detail-payload id field feeds which namespace. */
const DETAIL_FIELDS: Partial<Record<Namespace, string[]>> = {
  imdb: ['imdb'],
  anidb: ['anidb'],
  anilist: ['anilist'],
  mal: ['mal'],
  kitsu: ['kitsu'],
  tvdb_show: ['tvdb'],
  trakt: ['traktslug', 'trakt'],
  simkl: ['simkl', 'simkl_id'],
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const statusOf = (error: unknown): number | undefined =>
  axios.isAxiosError(error) ? error.response?.status : undefined;

/**
 * Resolve Simkl's `412` before treating it as anything.
 *
 * Probe a known-good sentinel: sentinel 200 means the original id is genuinely
 * unknown in that catalogue and is negative-cached; sentinel 412 means the
 * `client_id` itself is failing, so the breaker opens and the health page shows
 * it rather than every lookup silently returning nothing.
 */
async function classify412(
  client: SimklAPI,
  request: string,
  sourceKey: 'simkl-redirect' | 'simkl-detail'
): Promise<'not-found' | 'blocked'> {
  const healthy = await client.sentinelIsHealthy();
  if (healthy) {
    cacheNegative(sourceKey, request);
    return 'not-found';
  }
  tripCircuit('simkl-detail', 'sentinel probe also returned 412');
  tripCircuit('simkl-redirect', 'sentinel probe also returned 412');
  return 'blocked';
}

const simklKindForNamespace = (
  ns: Namespace
): 'anime' | 'tv' | 'movies' | undefined => {
  if (ns === 'tmdb_movie') return 'movies';
  if (ns === 'tmdb_show' || ns === 'tvdb_show') return 'tv';
  if (ns === 'anidb' || ns === 'anilist' || ns === 'mal' || ns === 'kitsu')
    return 'anime';
  return undefined;
};

/**
 * Simkl is the only free, no-auth, bidirectional resolver bridging
 * TMDB/TVDB <-> MAL/AniDB/AniList/Kitsu. It must never serve bulk: its docs ask
 * you to make contact before batch resolving, and over-use is punished by
 * client_id suspension with no warning and no appeal.
 */
export function simklResolver(
  createClient: () => SimklAPI = () => new SimklAPI()
): MappingResolver {
  return {
    key: 'simkl-live',
    kind: 'live',
    trust: 80,
    supports: (from, to) =>
      Boolean(REDIRECT_SOURCE[from.ns]) &&
      (Boolean(DETAIL_FIELDS[to]) || to === 'tmdb_show' || to === 'tmdb_movie'),
    resolve: async (from, to) => {
      const source = REDIRECT_SOURCE[from.ns];
      if (!source) return [];
      const request = `${from.ns}:${from.id}`;
      if (isNegativelyCached('simkl-redirect', request)) return [];

      let client: SimklAPI;
      try {
        client = createClient();
      } catch {
        // Simkl client id is not configured.
        return [];
      }

      let located: Awaited<ReturnType<SimklAPI['redirectToSimklId']>>;
      try {
        located = await withBudget('simkl-redirect', 'interactive', () =>
          client.redirectToSimklId(source, String(from.id))
        );
      } catch (error) {
        if (statusOf(error) === 412) {
          await classify412(client, request, 'simkl-redirect');
          return [];
        }
        throw error;
      }
      if (!located) {
        cacheNegative('simkl-redirect', request);
        return [];
      }

      const detailRequest = `${located.kind}/${located.simklId}`;
      if (isNegativelyCached('simkl-detail', detailRequest)) return [];

      let detail: Record<string, unknown>;
      try {
        detail = await withBudget('simkl-detail', 'interactive', () =>
          client.getTitle(located.kind, located.simklId)
        );
      } catch (error) {
        if (statusOf(error) === 412) {
          await classify412(client, detailRequest, 'simkl-detail');
          return [];
        }
        throw error;
      }

      const ids = isObject(detail.ids) ? detail.ids : {};
      const candidates: MappingCandidate[] = [];
      const via: IdRef[] = [from, { ns: 'simkl', id: located.simklId }];

      if (to === 'simkl') {
        return [
          {
            target: { ns: 'simkl', id: located.simklId },
            confidence: 85,
            sourceKey: 'simkl-live',
            via: [from],
          },
        ];
      }

      if (to === 'tmdb_show' || to === 'tmdb_movie') {
        // Simkl's own `tmdb` field measured 48.9-85.7% wrong for anime seasons,
        // so it is only ever offered at low confidence and the caller decides
        // whether a second namespace corroborates it. The media type comes from
        // Simkl's declared kind, never from probing.
        //
        // Anime is always a show-shaped answer here: writing the same integer
        // into `tmdb_movie` is how Slime Season 4 rendered as Chasing Mavericks
        // (movie/82684 vs tv/82684).
        if (located.kind === 'anime' && to === 'tmdb_movie') {
          return [];
        }
        const declared = simklKindForNamespace(to);
        if (declared && declared !== located.kind && located.kind !== 'anime') {
          return [];
        }
        const raw = Number(ids.tmdb);
        if (raw > 0) {
          candidates.push({
            target: { ns: to, id: String(raw) },
            confidence: located.kind === 'anime' ? 35 : 70,
            sourceKey: 'simkl-live:tmdb',
            via,
          });
        }
        return candidates;
      }

      for (const field of DETAIL_FIELDS[to] ?? []) {
        const value = ids[field];
        const id =
          typeof value === 'number'
            ? String(value)
            : typeof value === 'string' && value.trim()
              ? value.trim()
              : undefined;
        if (!id) continue;
        candidates.push({
          target: { ns: to, id },
          // These fields were correct in every traced case, unlike `tmdb`.
          confidence: 85,
          sourceKey: `simkl-live:${field}`,
          via,
        });
        break;
      }

      if (!candidates.length) cacheNegative('simkl-detail', detailRequest);
      return candidates;
    },
  };
}

/**
 * Seasons Simkl reports as mapped on TVDB, used to disambiguate a cour split
 * rather than guessing.
 */
export function simklMappedTvdbSeasons(
  detail: Record<string, unknown>
): number[] {
  const raw = detail.mapped_tvdb_seasons;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) =>
      isObject(entry) ? Number(entry.season ?? entry.number) : Number(entry)
    )
    .filter((season) => Number.isInteger(season) && season >= 0);
}

export function logSimklBlocked(reason: string): void {
  logger.error('Simkl resolver disabled', { label: 'Mapping', reason });
}
