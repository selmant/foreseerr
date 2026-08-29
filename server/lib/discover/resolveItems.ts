import type TheMovieDb from '@server/api/themoviedb';
import type {
  DiscoverMappingInfo,
  WatchlistItem,
} from '@server/interfaces/api/discoverInterfaces';
import { ensureMappingLayer } from '@server/lib/mapping/bootstrap';
import mappingService from '@server/lib/mapping/service';
import {
  tmdbNamespace,
  type IdRef,
  type Namespace,
} from '@server/lib/mapping/types';
import logger from '@server/logger';
import { hasDiscoverTmdbId } from './unmapped';
import { confirmOrRepair, confirmTmdbId } from './validity';

export interface ResolvableDiscoverItem extends WatchlistItem {
  /** Namespace and id to resolve from when `tmdbId` is missing. */
  from?: IdRef;
}

export interface ResolveDiscoverOptions {
  discoverSource: string;
  /** Skip live resolvers; used by bulk paths that must not spend quota. */
  offline?: boolean;
  /** Test seam: the same override `confirmOrRepair` already accepts. */
  tmdb?: TheMovieDb;
}

const stateFor = (
  resolved: boolean,
  ambiguous: boolean
): DiscoverMappingInfo['state'] =>
  resolved ? 'mapped' : ambiguous ? 'ambiguous' : 'unmapped';

/**
 * Fill in missing TMDB ids through the mapping layer and annotate every tile
 * with how it got there.
 *
 * Items that stay unresolved are annotated, not dropped: the caller decides
 * whether to hide them, and the gap is already recorded by the resolver.
 */
export async function resolveDiscoverItems(
  items: ResolvableDiscoverItem[],
  options: ResolveDiscoverOptions
): Promise<WatchlistItem[]> {
  if (!items.length) return [];
  ensureMappingLayer();

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

    // Without a declared media type both TMDB namespaces are legitimate
    // questions; asking both is what recovers a unified list's shows.
    const targets: Namespace[] = item.mediaType
      ? [tmdbNamespace(item.mediaType)]
      : ['tmdb_movie', 'tmdb_show'];

    let tmdbId: number | undefined;
    let mediaType = item.mediaType;
    let info: DiscoverMappingInfo = {
      state: 'unmapped',
      namespace: from.ns,
      externalId: String(from.id),
    };

    for (const target of targets) {
      try {
        const resolution = await mappingService.resolve(from, target, {
          discoverSource: options.discoverSource,
          offline: options.offline,
          title: item.title,
          mediaType: target === 'tmdb_movie' ? 'movie' : 'tv',
        });
        const candidate = Number(resolution.target?.id);
        if (
          candidate > 0 &&
          (await confirmTmdbId(
            target === 'tmdb_movie' ? 'movie' : 'tv',
            candidate,
            options.tmdb
          ))
        ) {
          tmdbId = candidate;
          mediaType = target === 'tmdb_movie' ? 'movie' : 'tv';
          info = {
            state: 'mapped',
            sourceKey: resolution.sourceKey,
            confidence: resolution.confidence,
            namespace: from.ns,
            externalId: String(from.id),
          };
          break;
        }
        if (resolution.ambiguous) {
          info = {
            ...info,
            state: 'ambiguous',
            sourceKey: resolution.sourceKey,
          };
        }
      } catch (error) {
        logger.debug('Discover mapping lookup failed', {
          label: 'Mapping',
          discoverSource: options.discoverSource,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }

    resolved.push({
      ...item,
      ...(tmdbId ? { tmdbId, id: tmdbId } : {}),
      ...(mediaType ? { mediaType } : {}),
      mappingState: {
        ...info,
        state: stateFor(Boolean(tmdbId), info.state === 'ambiguous'),
      },
    });
  }

  return resolved;
}
