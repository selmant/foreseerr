import type TheMovieDb from '@server/api/themoviedb';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import { resolveTmdb } from '@server/lib/mapping/resolve';
import type { IdRef } from '@server/lib/mapping/types';
import { withTmdbPoster } from './posters';
import { hasDiscoverTmdbId } from './unmapped';
import { confirmOrRepair, confirmTmdbId } from './validity';

export interface ResolvableDiscoverItem extends WatchlistItem {
  /** Namespace and id to resolve from when `tmdbId` is missing. */
  from?: IdRef;
}

export interface ResolveDiscoverOptions {
  discoverSource: string;
  /** Stay off the network: datasets and stored answers only. */
  offline?: boolean;
  /** Test seam: the same override `confirmOrRepair` already accepts. */
  tmdb?: TheMovieDb;
}

/**
 * Fill in missing TMDB ids through the mapping layer and annotate every tile
 * with how it got there.
 *
 * Items that stay unresolved are annotated, not dropped: the caller decides
 * whether to hide them and counts them in the unmapped list.
 */
export async function resolveDiscoverItems(
  items: ResolvableDiscoverItem[],
  options: ResolveDiscoverOptions
): Promise<WatchlistItem[]> {
  if (!items.length) return [];

  const resolved: WatchlistItem[] = [];
  for (const { from, ...item } of items) {
    if (hasDiscoverTmdbId(item.tmdbId)) {
      // An id that arrived is not an id that works: confirm it, and fall back
      // to the source's other ids when TMDB has deleted or merged the record.
      const confirmed = item.mediaType
        ? await confirmOrRepair(
            {
              tmdbId: item.tmdbId,
              mediaType: item.mediaType,
              title: item.title,
              refs: from ? [from] : [],
            },
            {
              discoverSource: options.discoverSource,
              offline: options.offline,
              namespace: from,
              tmdb: options.tmdb,
            }
          )
        : undefined;

      resolved.push({
        ...item,
        ...(confirmed
          ? {
              tmdbId: confirmed.tmdbId,
              ...(confirmed.tmdbId ? { id: confirmed.tmdbId } : {}),
              ...(confirmed.mediaType
                ? { mediaType: confirmed.mediaType }
                : {}),
            }
          : {}),
        mappingState: confirmed?.mappingState ?? { state: 'mapped' },
      });
      continue;
    }
    if (!from) {
      resolved.push({ ...item, mappingState: { state: 'unmapped' } });
      continue;
    }

    // Without a declared media type the answer settles it: a unified list's
    // shows are recovered by letting the resolver try both.
    const resolution = await resolveTmdb({
      refs: [from],
      mediaType: item.mediaType,
      title: item.title,
      discoverSource: options.discoverSource,
      offline: options.offline,
      tmdb: options.tmdb,
    });
    const source = { namespace: from.ns, externalId: String(from.id) };
    if (
      resolution &&
      (await confirmTmdbId(
        resolution.mediaType,
        resolution.tmdbId,
        options.tmdb
      ))
    ) {
      resolved.push({
        ...item,
        tmdbId: resolution.tmdbId,
        id: resolution.tmdbId,
        mediaType: resolution.mediaType,
        mappingState: {
          state: 'mapped',
          sourceKey: resolution.origin,
          ...source,
        },
      });
      continue;
    }
    resolved.push({ ...item, mappingState: { state: 'unmapped', ...source } });
  }

  return Promise.all(
    resolved.map((item) => withTmdbPoster(item, options.tmdb))
  );
}
