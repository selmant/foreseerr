import type { MappingGapReason } from '@server/entity/MappingGap';
import type {
  DiscoverItemSource,
  WatchlistItem,
} from '@server/interfaces/api/discoverInterfaces';
import { parseDiscoverTruthyQuery } from '@server/lib/discover/filterOptions';
import {
  recordMappingGap,
  type MappingGapObservation,
} from '@server/lib/mapping/gaps';
import { isNamespace, type Namespace } from '@server/lib/mapping/types';

/**
 * Proves only that an integer arrived. A present id is not a valid id: three
 * couchmoney list items carried plausible ids that 404 on TMDB and rendered as
 * broken cards, so validity is a separate check (see `recordUnmappedItems`).
 */
export function hasDiscoverTmdbId(
  tmdbId: number | null | undefined
): tmdbId is number {
  return typeof tmdbId === 'number' && Number.isFinite(tmdbId) && tmdbId > 0;
}

export function shouldHideUnmappedFromQuery(query: {
  hideUnmapped?: unknown;
}): boolean {
  return parseDiscoverTruthyQuery(query.hideUnmapped);
}

/** Namespace an unresolved item is recorded under, per discover source. */
const SOURCE_NAMESPACE: Record<DiscoverItemSource, Namespace> = {
  trakt: 'trakt',
  anilist: 'anilist',
  simkl: 'simkl',
  mdblist: 'imdb',
  plex: 'imdb',
};

export interface UnmappedRecordOptions {
  discoverSource?: string;
  reason?: MappingGapReason;
  namespace?: Namespace;
  sourceKey?: string;
}

/**
 * Record every item that arrived without a usable TMDB id. Filtering an item is
 * also an event, and until it is recorded the gap is invisible to the health
 * page and the repair queue.
 */
export function recordUnmappedItems(
  items: (Pick<
    WatchlistItem,
    'tmdbId' | 'title' | 'mediaType' | 'mappingState'
  > & {
    source?: DiscoverItemSource;
    sourceId?: string;
  })[],
  options: UnmappedRecordOptions = {}
): void {
  for (const item of items) {
    if (hasDiscoverTmdbId(item.tmdbId)) continue;
    const mappedNamespace = item.mappingState?.namespace;
    const namespace =
      (mappedNamespace && isNamespace(mappedNamespace)
        ? mappedNamespace
        : undefined) ??
      options.namespace ??
      (item.source ? SOURCE_NAMESPACE[item.source] : undefined);
    const externalId = item.mappingState?.externalId ?? item.sourceId;
    if (!namespace || !externalId) continue;
    const observation: MappingGapObservation = {
      namespace,
      externalId,
      title: item.title,
      mediaType: item.mediaType,
      discoverSource: options.discoverSource ?? item.source,
      reason: options.reason ?? 'unresolved',
      sourceKey: options.sourceKey,
    };
    recordMappingGap(observation);
  }
}

export function omitUnmappedDiscoverItems<T extends { tmdbId?: number | null }>(
  items: T[],
  hideUnmapped: boolean
): T[] {
  if (!hideUnmapped) {
    return items;
  }
  return items.filter((item) => hasDiscoverTmdbId(item.tmdbId));
}

export function anilistSourceUrl(anilistId: number): string {
  return `https://anilist.co/anime/${anilistId}`;
}

export function traktSourceUrl(
  mediaType: 'movie' | 'tv',
  slugOrId: string | number
): string {
  return `https://trakt.tv/${mediaType === 'movie' ? 'movies' : 'shows'}/${slugOrId}`;
}

export function imdbSourceUrl(imdbId: string): string {
  return `https://www.imdb.com/title/${imdbId}`;
}

export function tmdbSourceUrl(
  mediaType: 'movie' | 'tv',
  tmdbId: number
): string {
  return `https://www.themoviedb.org/${mediaType}/${tmdbId}`;
}
