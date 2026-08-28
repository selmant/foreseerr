import Tvdb from '@server/api/tvdb';
import {
  cacheNegative,
  isNegativelyCached,
  withBudget,
} from '@server/lib/mapping/budget';
import type {
  MappingCandidate,
  MappingResolver,
  Namespace,
} from '@server/lib/mapping/types';

/** Namespaces TVDB's remoteid search accepts as input. */
const REMOTE_SUPPORTED: Namespace[] = ['imdb', 'tmdb_movie', 'tmdb_show'];

/**
 * TVDB is the numbering authority — Sonarr organises anime by TVDB seasons and
 * absolute numbers, so a mapping that never consults TVDB cannot route a
 * request correctly. Its free tier requires a subscriber PIN, so this resolver
 * stays disabled unless TVDB is actually reachable.
 */
export function tvdbResolver(
  getClient: () => Promise<Tvdb> = () => Tvdb.getInstance()
): MappingResolver {
  return {
    key: 'tvdb-remoteid',
    kind: 'live',
    trust: 90,
    supports: (from, to) =>
      REMOTE_SUPPORTED.includes(from.ns) &&
      (to === 'tvdb_show' || to === 'tvdb_movie'),
    resolve: async (from, to): Promise<MappingCandidate[]> => {
      const request = `${from.ns}:${from.id}`;
      if (isNegativelyCached('tvdb', request)) return [];

      let client: Tvdb;
      try {
        client = await getClient();
      } catch {
        // No PIN configured or login failed; TVDB simply does not participate.
        return [];
      }

      const wanted = to === 'tvdb_movie' ? 'movie' : 'series';
      const matches = await withBudget('tvdb', 'interactive', () =>
        client.searchRemoteId(String(from.id))
      );
      const scoped = matches.filter((match) => match.type === wanted);
      if (!scoped.length) {
        if (!matches.length) cacheNegative('tvdb', request);
        return [];
      }

      return scoped.map((match) => ({
        target: { ns: to, id: String(match.tvdbId) },
        confidence: 90,
        sourceKey: 'tvdb-remoteid',
        via: [from],
      }));
    },
  };
}
