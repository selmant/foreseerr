import type { AnilistMediaFormat } from '@server/api/anilist/interfaces';
import { confirmTmdbId } from '@server/lib/discover/validity';
import { ensureMappingLayer } from '@server/lib/mapping/bootstrap';
import { findClusterIds, findLinks } from '@server/lib/mapping/graph';
import mappingService from '@server/lib/mapping/service';
import { tmdbNamespace, type Namespace } from '@server/lib/mapping/types';

export interface AnilistTmdbMapping {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
}

interface FribbTmdbIds {
  tv?: number;
  movie?: number | number[];
}

const SERIES_FRIBB_TYPES = new Set(['TV', 'ONA', 'TV_SHORT']);

export interface AnilistSeasonMapping {
  anilistId: number;
  type?: string;
  seasonTmdb: number | null;
  seasonTvdb: number | null;
  offsetTmdb: number;
  offsetTvdb: number;
}

function parseNonNegativeInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.trunc(parsed);
}

export function isSeriesFribbType(type?: string | null): boolean {
  return !type || SERIES_FRIBB_TYPES.has(type);
}

function firstMovieId(ids?: FribbTmdbIds): number | undefined {
  const movie = ids?.movie;
  if (Array.isArray(movie)) {
    const id = Number(movie[0]);
    return Number.isFinite(id) && id > 0 ? id : undefined;
  }
  if (movie != null) {
    const id = Number(movie);
    return Number.isFinite(id) && id > 0 ? id : undefined;
  }
  return undefined;
}

function tvId(ids?: FribbTmdbIds): number | undefined {
  if (ids?.tv == null) {
    return undefined;
  }
  const id = Number(ids.tv);
  return Number.isFinite(id) && id > 0 ? id : undefined;
}

export function anilistFormatToMediaType(
  format?: AnilistMediaFormat | null
): 'movie' | 'tv' {
  return format === 'MOVIE' ? 'movie' : 'tv';
}

/**
 * Retained from the old bespoke Fribb loader because the format still needs the
 * movie-versus-tv preference rule; the download, indexing, and lookup all moved
 * to the pack framework and the mapping graph.
 */
export function resolveFribbTmdb(
  ids: FribbTmdbIds | undefined,
  format?: AnilistMediaFormat | null
): AnilistTmdbMapping | null {
  const movie = firstMovieId(ids);
  const tv = tvId(ids);
  const preferMovie = anilistFormatToMediaType(format) === 'movie';

  if (preferMovie && movie) {
    return { tmdbId: movie, mediaType: 'movie' };
  }
  if (!preferMovie && tv) {
    return { tmdbId: tv, mediaType: 'tv' };
  }
  if (tv) {
    return { tmdbId: tv, mediaType: 'tv' };
  }
  if (movie) {
    return { tmdbId: movie, mediaType: 'movie' };
  }
  return null;
}

function offsetForCatalog(
  entry: AnilistSeasonMapping,
  catalog: 'tmdb' | 'tvdb'
): number {
  return catalog === 'tvdb' ? entry.offsetTvdb : entry.offsetTmdb;
}

export function fribbSeasonCandidates(
  entries: AnilistSeasonMapping[],
  seasonNumber: number
): {
  catalog: 'tmdb' | 'tvdb';
  mode: 'in-season' | 'absolute';
  entries: AnilistSeasonMapping[];
} {
  const series = entries.filter(
    (entry) => isSeriesFribbType(entry.type) && entry.anilistId > 0
  );
  if (seasonNumber < 1 || series.length === 0) {
    return { catalog: 'tmdb', mode: 'in-season', entries: [] };
  }
  if (series.length === 1) {
    return { catalog: 'tmdb', mode: 'absolute', entries: series };
  }

  const tmdbHits = series.filter((entry) => entry.seasonTmdb === seasonNumber);
  const tvdbHits = series.filter((entry) => entry.seasonTvdb === seasonNumber);
  const tmdbSeasons = new Set(
    series
      .map((entry) => entry.seasonTmdb)
      .filter((season): season is number => season != null && season > 0)
  );
  const tvdbSeasons = new Set(
    series
      .map((entry) => entry.seasonTvdb)
      .filter((season): season is number => season != null && season > 0)
  );
  const tmdbCollapsed = tmdbSeasons.size <= 1 && tvdbSeasons.size > 1;
  if (tmdbCollapsed) {
    return { catalog: 'tvdb', mode: 'in-season', entries: tvdbHits };
  }
  if (tmdbHits.length > 0) {
    return { catalog: 'tmdb', mode: 'in-season', entries: tmdbHits };
  }
  return { catalog: 'tvdb', mode: 'in-season', entries: tvdbHits };
}

export function pickFribbSeasonEntry(
  entries: AnilistSeasonMapping[],
  seasonNumber: number,
  episodeNumber: number
): {
  mapping: AnilistSeasonMapping;
  progress: number;
  mode: 'in-season' | 'absolute';
} | null {
  if (episodeNumber < 1) {
    return null;
  }
  const {
    catalog,
    mode,
    entries: hits,
  } = fribbSeasonCandidates(entries, seasonNumber);
  if (hits.length === 0) {
    return null;
  }
  if (mode === 'absolute') {
    return { mapping: hits[0], progress: episodeNumber, mode };
  }
  const sorted = [...hits].sort(
    (left, right) =>
      offsetForCatalog(left, catalog) - offsetForCatalog(right, catalog) ||
      left.anilistId - right.anilistId
  );
  const picked =
    sorted.length === 1
      ? sorted[0]
      : sorted.find((entry, index) => {
          const start = offsetForCatalog(entry, catalog) + 1;
          const next = sorted[index + 1];
          const end = next
            ? offsetForCatalog(next, catalog)
            : Number.POSITIVE_INFINITY;
          return episodeNumber >= start && episodeNumber <= end;
        });
  if (!picked) {
    return null;
  }
  const progress = episodeNumber - offsetForCatalog(picked, catalog);
  if (progress < 1) {
    return null;
  }
  return { mapping: picked, progress, mode };
}

/**
 * Thin delegates onto `MappingService`.
 *
 * The bespoke downloader and in-process index this file used to own are gone:
 * Fribb is now one declarative pack among several (and demoted, since its
 * AniList/MAL fields froze on 2026-07-07 when upstream manami was archived), and
 * lookups go through the persistent mapping graph.
 */
class AnilistIdMapping {
  public isLoaded = (): boolean => true;

  public sync = async (): Promise<void> => {
    ensureMappingLayer();
  };

  public getFromAnilistId = async (
    anilistId: number,
    preferred?: 'movie' | 'tv'
  ): Promise<AnilistTmdbMapping | undefined> => {
    // AniList's format is the only authoritative media-type signal here.
    // Falling through from show to movie for a TV series is how Slime Season 4
    // rendered as Chasing Mavericks: the same integer is a real movie 63% of
    // the time, so existence of /movie/{id} is not evidence of identity.
    const order: [Namespace, 'movie' | 'tv'][] =
      preferred === 'movie'
        ? [['tmdb_movie', 'movie']]
        : preferred === 'tv'
          ? [['tmdb_show', 'tv']]
          : [
              ['tmdb_show', 'tv'],
              ['tmdb_movie', 'movie'],
            ];

    for (const [namespace, mediaType] of order) {
      const resolution = await mappingService.resolve(
        { ns: 'anilist', id: String(anilistId) },
        namespace,
        { silent: true, mediaType }
      );
      const tmdbId = Number(resolution.target?.id);
      if (!(tmdbId > 0)) continue;
      // Existence may only reject. A live id in the wrong namespace is still wrong.
      if (!(await confirmTmdbId(mediaType, tmdbId))) continue;
      return { tmdbId, mediaType };
    }
    return undefined;
  };

  public getAnilistId = async (
    mediaType: 'movie' | 'tv',
    tmdbId: number
  ): Promise<number | undefined> => {
    const ids = await this.getAnilistIds(mediaType, tmdbId);
    return ids[0];
  };

  public getAnilistIds = async (
    mediaType: 'movie' | 'tv',
    tmdbId: number
  ): Promise<number[]> => {
    const clusterIds = await findClusterIds({
      ns: tmdbNamespace(mediaType),
      id: String(tmdbId),
    });
    const links = await findLinks(clusterIds, 'anilist');
    return [
      ...new Set(
        links
          .map((link) => Number(link.externalId))
          .filter((id) => Number.isFinite(id) && id > 0)
      ),
    ];
  };

  /**
   * Season-scoped AniList links for one TMDB show, in the shape the existing
   * episode call sites expect. Phase 5 replaces this with the episode rule
   * engine; until then it is derived from the graph rather than from Fribb's
   * `episode_offset` field, which was populated for only 1.57% of entries.
   */
  public getAnilistSeasonEntries = async (
    mediaType: 'movie' | 'tv',
    tmdbId: number
  ): Promise<AnilistSeasonMapping[]> => {
    const namespace = tmdbNamespace(mediaType);
    const clusterIds = await findClusterIds({
      ns: namespace,
      id: String(tmdbId),
    });
    if (!clusterIds.length) return [];
    const [anilistLinks, tmdbLinks, tvdbLinks] = await Promise.all([
      findLinks(clusterIds, 'anilist'),
      findLinks(clusterIds, namespace),
      findLinks(clusterIds, 'tvdb_show'),
    ]);
    const seasonFor = (
      links: { clusterId: number; season?: number }[],
      clusterId: number
    ): number | null =>
      links.find((link) => link.clusterId === clusterId)?.season ?? null;
    return anilistLinks.map((link) => ({
      anilistId: Number(link.externalId),
      seasonTmdb: seasonFor(tmdbLinks, link.clusterId),
      seasonTvdb: seasonFor(tvdbLinks, link.clusterId),
      offsetTmdb: 0,
      offsetTvdb: 0,
    }));
  };
}

const anilistIdMapping = new AnilistIdMapping();

export default anilistIdMapping;
export { parseNonNegativeInt };
