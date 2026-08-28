import {
  cacheNegative,
  isNegativelyCached,
  withBudget,
} from '@server/lib/mapping/budget';
import type { MappingResolver, Namespace } from '@server/lib/mapping/types';
import axios from 'axios';

const BASE_URL = 'https://kitsu.io/api/edge';

/** Kitsu's `externalSite` enum values. */
const EXTERNAL_SITE: Partial<Record<Namespace, string>> = {
  mal: 'myanimelist/anime',
  anidb: 'anidb',
  anilist: 'anilist/anime',
  tvdb_show: 'thetvdb/series',
  trakt: 'trakt',
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

interface KitsuMapping {
  attributes?: { externalSite?: string; externalId?: string };
  relationships?: { item?: { data?: { id?: string; type?: string } } };
}

/**
 * Zero-auth and good for MAL/AniDB/AniList/TVDB/Trakt, but it exposes **no TMDB
 * ids at all**, so it only ever bridges toward another namespace.
 */
export function kitsuResolver(): MappingResolver {
  return {
    key: 'kitsu',
    kind: 'live',
    trust: 65,
    supports: (from, to) =>
      (Boolean(EXTERNAL_SITE[from.ns]) && to === 'kitsu') ||
      (from.ns === 'kitsu' && Boolean(EXTERNAL_SITE[to])),
    resolve: async (from, to) => {
      const forward = from.ns !== 'kitsu';
      const site = EXTERNAL_SITE[forward ? from.ns : to];
      if (!site) return [];
      const request = forward
        ? `${site}/${from.id}`
        : `kitsu/${from.id}->${site}`;
      if (isNegativelyCached('kitsu', request)) return [];

      const params = forward
        ? {
            'filter[externalSite]': site,
            'filter[externalId]': String(from.id),
            include: 'item',
          }
        : {
            'filter[itemId]': String(from.id),
            'filter[itemType]': 'Anime',
            'filter[externalSite]': site,
          };

      const payload = await withBudget('kitsu', 'interactive', async () => {
        const { data } = await axios.get<unknown>(`${BASE_URL}/mappings`, {
          params,
          timeout: 15000,
          headers: { Accept: 'application/vnd.api+json' },
        });
        return data;
      });

      const rows =
        isObject(payload) && Array.isArray(payload.data)
          ? (payload.data as KitsuMapping[])
          : [];
      const ids = new Set<string>();
      for (const row of rows) {
        const id = forward
          ? row.relationships?.item?.data?.id
          : row.attributes?.externalId;
        if (id) ids.add(String(id));
      }
      if (!ids.size) {
        cacheNegative('kitsu', request);
        return [];
      }
      return [...ids].map((id) => ({
        target: { ns: to, id },
        confidence: 65,
        sourceKey: 'kitsu',
        via: [from],
      }));
    },
  };
}
