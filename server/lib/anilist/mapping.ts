import type {
  AnilistMedia,
  AnilistMediaFormat,
} from '@server/api/anilist/interfaces';
import { confirmTmdbId } from '@server/lib/discover/validity';
import { ensureMappingLayer } from '@server/lib/mapping/datasets';
import { edgesFrom, edgesTo } from '@server/lib/mapping/edges';
import {
  parseEpisodeRange,
  parseRangePair,
} from '@server/lib/mapping/episodes';
import { resolveTmdb } from '@server/lib/mapping/resolve';
import {
  scopeSeason,
  tmdbNamespace,
  type MediaType,
} from '@server/lib/mapping/types';

export interface AnilistTmdbMapping {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
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

export function isSeriesFribbType(type?: string | null): boolean {
  return !type || SERIES_FRIBB_TYPES.has(type);
}

export function anilistFormatToMediaType(
  format?: AnilistMediaFormat | null
): 'movie' | 'tv' {
  return format === 'MOVIE' ? 'movie' : 'tv';
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

export interface AnilistLookupHints {
  title?: string;
  year?: number;
  /** The AniList record, when the caller has it: titles, format, relations. */
  media?: AnilistMedia | null;
  /**
   * Datasets and stored answers only. For bulk paths such as a user's whole
   * list, where a TMDB search per unknown entry would stall the request.
   */
  offline?: boolean;
}

/**
 * How far into a catalogue season an entry starts, from a stated range read
 * from the entry's side. An entry whose episode 1 is the season's episode 13
 * has offset 12; one whose episode 27 is the season's episode 1, because it
 * carries on from the previous season, has offset -26.
 */
const offsetOf = (
  entryRange?: string | null,
  seasonRange?: string | null
): number => {
  if (!entryRange || !seasonRange) return 0;
  const [rule] = parseRangePair(entryRange, seasonRange);
  return rule ? rule.targetRange.start - rule.sourceRange.start : 0;
};

const rangeStart = (range?: string | null): number =>
  parseEpisodeRange(range ?? '')?.start ?? Number.MAX_SAFE_INTEGER;

/** AniList-facing view of the mapping layer. */
class AnilistIdMapping {
  public isLoaded = (): boolean => true;

  public sync = async (): Promise<void> => {
    await ensureMappingLayer();
  };

  public getFromAnilistId = async (
    anilistId: number,
    preferred?: 'movie' | 'tv',
    hints: AnilistLookupHints = {}
  ): Promise<AnilistTmdbMapping | undefined> => {
    const { media } = hints;
    // AniList's format is the only authoritative media-type signal here.
    // Falling through from show to movie for a TV series is how Slime Season 4
    // rendered as Chasing Mavericks: the same integer is a real movie 63% of
    // the time, so existence of /movie/{id} is not evidence of identity.
    const declared =
      preferred ??
      (media?.format ? anilistFormatToMediaType(media.format) : undefined);
    const order: MediaType[] = declared ? [declared] : ['tv', 'movie'];
    const titles = [
      media?.title?.native,
      media?.title?.romaji,
      media?.title?.english,
      hints.title,
    ].filter((title): title is string => Boolean(title?.trim()));
    const year =
      media?.startDate?.year ?? media?.seasonYear ?? hints.year ?? undefined;

    for (const mediaType of order) {
      const resolution = await resolveTmdb({
        refs: [{ ns: 'anilist', id: String(anilistId) }],
        mediaType,
        title: hints.title ?? titles[0],
        year,
        discoverSource: 'anilist',
        offline: hints.offline,
        anime: {
          anilistId,
          titles,
          year,
          format: media?.format,
          // Undefined lets the fallback ask AniList; a page query already has them.
          ...(media?.relations
            ? { relations: media.relations.edges ?? [] }
            : {}),
        },
      });
      if (!resolution) continue;
      // Existence may only reject. A live id in the wrong namespace is still wrong.
      if (!(await confirmTmdbId(resolution.mediaType, resolution.tmdbId))) {
        continue;
      }
      return { tmdbId: resolution.tmdbId, mediaType: resolution.mediaType };
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
    const edges = edgesTo(
      await edgesFrom(tmdbNamespace(mediaType), String(tmdbId)),
      'anilist'
    );
    return [
      ...new Set(
        edges
          .map((edge) => Number(edge.dstId))
          .filter((id) => Number.isFinite(id) && id > 0)
      ),
    ];
  };

  /**
   * The AniList entries that make up one TMDB show, with the season each sits
   * in on TMDB and on TVDB. Used when no episode range covers an episode and
   * the entry has to be inferred from the season instead.
   */
  public getAnilistSeasonEntries = async (
    mediaType: 'movie' | 'tv',
    tmdbId: number
  ): Promise<AnilistSeasonMapping[]> => {
    const edges = edgesTo(
      await edgesFrom(tmdbNamespace(mediaType), String(tmdbId)),
      'anilist'
    );

    // One entry per AniList id and season: a single AniList entry often runs
    // across several TMDB seasons, and each needs its own offset. The earliest
    // stated range in a season gives where the entry starts in it.
    const first = new Map<string, (typeof edges)[number]>();
    for (const edge of [...edges].sort(
      (a, b) => rangeStart(a.srcRange) - rangeStart(b.srcRange)
    )) {
      const key = `${edge.dstId}:${edge.srcScope}`;
      if (!first.has(key)) first.set(key, edge);
    }

    const entries: AnilistSeasonMapping[] = [];
    for (const edge of first.values()) {
      const anilistId = Number(edge.dstId);
      if (!(anilistId > 0)) continue;
      const seasonTmdb = scopeSeason(edge.srcScope) ?? null;
      // The entry's own edges say which TVDB season holds the same episodes.
      const tvdbEdges = edgesTo(
        await edgesFrom('anilist', edge.dstId),
        'tvdb_show'
      );
      const entryStart = rangeStart(edge.dstRange);
      const tvdb =
        tvdbEdges.find((candidate) => {
          const range = parseEpisodeRange(candidate.srcRange ?? '');
          return (
            range !== undefined &&
            range.start <= entryStart &&
            (range.end === undefined || entryStart <= range.end)
          );
        }) ?? tvdbEdges[0];
      entries.push({
        anilistId,
        // Season 0 holds specials and films, never the series itself.
        ...(seasonTmdb === 0 ? { type: 'SPECIAL' } : {}),
        seasonTmdb,
        seasonTvdb: tvdb ? (scopeSeason(tvdb.dstScope) ?? null) : null,
        offsetTmdb: offsetOf(edge.dstRange, edge.srcRange),
        offsetTvdb: offsetOf(tvdb?.srcRange, tvdb?.dstRange),
      });
    }
    return entries;
  };
}

const anilistIdMapping = new AnilistIdMapping();

export default anilistIdMapping;
