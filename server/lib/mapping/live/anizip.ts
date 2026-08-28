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
import axios from 'axios';

const BASE_URL = 'https://api.ani.zip';

const QUERY_PARAM: Partial<Record<Namespace, string>> = {
  anilist: 'anilist_id',
  anidb: 'anidb_id',
  mal: 'mal_id',
  tvdb_show: 'tvdb_id',
};

const RESPONSE_FIELD: Partial<Record<Namespace, string>> = {
  anilist: 'anilist_id',
  anidb: 'anidb_id',
  mal: 'mal_id',
  kitsu: 'kitsu_id',
  tvdb_show: 'thetvdb_id',
  imdb: 'imdb_id',
  tmdb_show: 'themoviedb_id',
};

export interface AnizipEpisode {
  tvdbShowId?: number;
  seasonNumber?: number;
  episodeNumber?: number;
  absoluteEpisodeNumber?: number;
}

export interface AnizipMappings {
  ids: Record<string, string | number>;
  episodes: Record<string, AnizipEpisode>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export async function fetchAnizipMappings(
  namespace: Namespace,
  externalId: string
): Promise<AnizipMappings | undefined> {
  const parameter = QUERY_PARAM[namespace];
  if (!parameter) return undefined;
  const request = `${parameter}=${externalId}`;
  if (isNegativelyCached('anizip', request)) return undefined;

  const payload = await withBudget('anizip', 'interactive', async () => {
    const { data } = await axios.get<unknown>(`${BASE_URL}/mappings`, {
      params: { [parameter]: externalId },
      timeout: 15000,
    });
    return data;
  });

  if (!isObject(payload)) {
    cacheNegative('anizip', request);
    return undefined;
  }
  const mappings = isObject(payload.mappings) ? payload.mappings : payload;
  const episodes = isObject(payload.episodes) ? payload.episodes : {};
  return {
    ids: Object.fromEntries(
      Object.entries(mappings).filter(
        ([, value]) => typeof value === 'string' || typeof value === 'number'
      )
    ) as Record<string, string | number>,
    episodes: Object.fromEntries(
      Object.entries(episodes)
        .filter(([, value]) => isObject(value))
        .map(([key, value]) => {
          const episode = value as Record<string, unknown>;
          return [
            key,
            {
              tvdbShowId: Number(episode.tvdbShowId) || undefined,
              seasonNumber: Number(episode.seasonNumber) || undefined,
              episodeNumber: Number(episode.episodeNumber) || undefined,
              absoluteEpisodeNumber:
                Number(episode.absoluteEpisodeNumber) || undefined,
            },
          ];
        })
    ),
  };
}

/**
 * `api.ani.zip` supplies the per-episode layer no static pack has (One Piece
 * returns 1,264 episodes with absolute numbering). It has no repository, no docs
 * and no named operator, so it is secondary only and never a system of record.
 */
export function anizipResolver(): MappingResolver {
  return {
    key: 'anizip',
    kind: 'live',
    trust: 60,
    supports: (from, to) =>
      Boolean(QUERY_PARAM[from.ns]) && Boolean(RESPONSE_FIELD[to]),
    resolve: async (from, to): Promise<MappingCandidate[]> => {
      const mappings = await fetchAnizipMappings(from.ns, String(from.id));
      const field = RESPONSE_FIELD[to];
      if (!mappings || !field) return [];
      const raw = mappings.ids[field];
      const id =
        typeof raw === 'number'
          ? String(raw)
          : typeof raw === 'string' && raw.trim()
            ? raw.trim()
            : undefined;
      if (!id) return [];
      return [
        {
          target: { ns: to, id },
          confidence: 60,
          sourceKey: 'anizip',
          via: [from],
        },
      ];
    },
  };
}
