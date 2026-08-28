import type {
  MappingCostClass,
  MappingPackFormat,
  NamespaceTrust,
} from '@server/entity/MappingSource';
import type { Namespace } from '@server/lib/mapping/types';
import logger from '@server/logger';
import axios from 'axios';

export interface PackManifestEntry {
  key: string;
  format: MappingPackFormat;
  /** Ordered: upstream, CDN, then the homelab mirror of last resort. */
  mirrors: string[];
  enabled: boolean;
  priority: number;
  trust: number;
  namespaceTrust?: NamespaceTrust;
  fieldMap?: Record<string, string>;
  /** `field -> field naming its media type`, for single-column sources. */
  typeFields?: Record<string, string>;
  namespaceMap?: Record<string, Namespace>;
  licence?: string;
  legalNote?: string;
  costClass?: MappingCostClass;
}

export interface PackManifest {
  version: number;
  packs: PackManifestEntry[];
}

/**
 * The manifest is data, not code: adding a source, repointing a dead URL, or
 * changing precedence is a config edit. The bundled copy below is the offline
 * default; `MAPPING_MANIFEST_URL` overrides it at runtime so the source list can
 * be updated without shipping a release.
 */
export const BUNDLED_MANIFEST: PackManifest = {
  version: 1,
  packs: [
    {
      key: 'anibridge',
      format: 'json-graph',
      mirrors: [
        'https://github.com/anibridge/anibridge-mappings/releases/download/v3/mappings.min.json',
        'https://cdn.jsdelivr.net/gh/anibridge/anibridge-mappings@v3/mappings.min.json',
      ],
      enabled: true,
      priority: 10,
      trust: 90,
      namespaceTrust: {
        tmdb_show: 90,
        tmdb_movie: 90,
        tvdb_show: 90,
        anidb: 95,
        anilist: 95,
        mal: 90,
        kitsu: 85,
      },
      licence: 'MIT',
    },
    {
      key: 'animeapi',
      format: 'json-array',
      mirrors: [
        'https://raw.githubusercontent.com/nattadasu/animeApi/v3/database/animeapi.json',
        'https://cdn.jsdelivr.net/gh/nattadasu/animeApi@v3/database/animeapi.json',
      ],
      enabled: true,
      priority: 20,
      trust: 70,
      // The only maintained free source carrying Trakt and Simkl anime ids.
      namespaceTrust: { trakt: 75, simkl: 75, anidb: 80, anilist: 80 },
      fieldMap: {
        anidb: 'anidb',
        anilist: 'anilist',
        kitsu: 'kitsu',
        mal: 'myanimelist',
        trakt: 'trakt',
        simkl: 'simkl',
        imdb: 'imdb',
        tmdb_show: 'themoviedb',
        tvdb_show: 'thetvdb',
        livechart: 'livechart',
        animeplanet: 'animeplanet',
        anisearch: 'anisearch',
      },
      // `themoviedb` holds films and series alike; only `themoviedb_type` says
      // which, and a mistyped id renders someone else's poster.
      typeFields: { themoviedb: 'themoviedb_type' },
      licence: 'MIT',
    },
    {
      key: 'fribb',
      format: 'json-array',
      mirrors: [
        'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json',
        'https://cdn.jsdelivr.net/gh/Fribb/anime-lists@master/anime-list-full.json',
      ],
      enabled: true,
      // Demoted to fallback: its generator reads the archived manami project and
      // its AniList/MAL fields stopped changing on 2026-07-07.
      priority: 80,
      trust: 40,
      namespaceTrust: {
        anilist: 25,
        mal: 25,
        kitsu: 25,
        anidb: 55,
        tmdb_show: 40,
      },
      fieldMap: {
        anidb: 'anidb_id',
        anilist: 'anilist_id',
        mal: 'mal_id',
        kitsu: 'kitsu_id',
        imdb: 'imdb_id',
        tvdb_show: 'tvdb_id',
        // Nested as `{ tv, movie }`, so the parser splits it across both TMDB
        // namespaces; without it Fribb contributes no TMDB edge at all.
        tmdb_show: 'themoviedb_id',
        simkl: 'simkl_id',
        livechart: 'livechart_id',
        animeplanet: 'anime-planet_id',
        anisearch: 'anisearch_id',
      },
      licence: 'MIT',
      legalNote:
        'AniList/MAL/Kitsu fields are frozen as of 2026-07-07 because the upstream manami-project database was archived. Kept only as a fallback.',
    },
    {
      key: 'anime-lists',
      format: 'xml-animelist',
      mirrors: [
        'https://raw.githubusercontent.com/Anime-Lists/anime-lists/master/anime-list-master.xml',
        'https://cdn.jsdelivr.net/gh/Anime-Lists/anime-lists@master/anime-list-master.xml',
      ],
      // Off by default: the repository carries no license at all.
      enabled: false,
      priority: 40,
      trust: 75,
      namespaceTrust: { anidb: 90, tvdb_show: 85, imdb: 80 },
      licence: 'none',
      legalNote:
        'Anime-Lists/anime-lists publishes no license. Enabling it is your decision; a licence request has been open upstream since 2026-07-25.',
    },
  ],
};

const isManifest = (value: unknown): value is PackManifest => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as PackManifest;
  return (
    typeof candidate.version === 'number' &&
    Array.isArray(candidate.packs) &&
    candidate.packs.every(
      (pack) =>
        typeof pack?.key === 'string' &&
        typeof pack?.format === 'string' &&
        Array.isArray(pack?.mirrors)
    )
  );
};

export async function fetchManifest(
  url = process.env.MAPPING_MANIFEST_URL
): Promise<PackManifest> {
  if (!url) return BUNDLED_MANIFEST;
  try {
    const { data } = await axios.get<unknown>(url, { timeout: 15000 });
    if (!isManifest(data)) {
      throw new Error('manifest did not match the expected shape');
    }
    return data;
  } catch (error) {
    logger.warn('Falling back to the bundled mapping manifest', {
      label: 'Mapping',
      url,
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return BUNDLED_MANIFEST;
  }
}

/**
 * Extra mirrors appended to every pack, so a homelab S3/Forgejo copy can be the
 * last resort without editing each entry. Comma-separated template URLs where
 * `{key}` is the pack key.
 */
export function extraMirrors(key: string): string[] {
  const template = process.env.MAPPING_MIRROR_TEMPLATES;
  if (!template) return [];
  return template
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/\{key\}/g, key));
}
