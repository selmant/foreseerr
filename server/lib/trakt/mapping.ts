import type { TraktMediaItem } from '@server/api/trakt/interfaces';
import { confirmOrRepair } from '@server/lib/discover/validity';
import { ensureMappingLayer } from '@server/lib/mapping/bootstrap';
import mappingService from '@server/lib/mapping/service';
import { tmdbNamespace, type IdRef } from '@server/lib/mapping/types';
import logger from '@server/logger';

/** How a Trakt item is identified in the gap queue. */
const traktRef = (item: TraktMediaItem): IdRef | undefined => {
  const id =
    item.traktSlug ?? (item.traktId ? String(item.traktId) : undefined);
  return id ? { ns: 'trakt', id } : undefined;
};

/** Ids Trakt supplies, in the order they resolve most reliably. */
export const sourceRefs = (item: TraktMediaItem): IdRef[] => {
  const refs: IdRef[] = [];
  if (item.imdbId) refs.push({ ns: 'imdb', id: item.imdbId });
  if (item.tvdbId && item.mediaType === 'tv') {
    refs.push({ ns: 'tvdb_show', id: String(item.tvdbId) });
  }
  if (item.traktSlug) refs.push({ ns: 'trakt', id: item.traktSlug });
  else if (item.traktId) refs.push({ ns: 'trakt', id: String(item.traktId) });
  return refs;
};

/**
 * Fill in TMDB ids Trakt did not supply.
 *
 * Trakt items without a TMDB id are otherwise dropped by every downstream step
 * that keys off it — the anime keyword check treats a missing id as "not anime",
 * which silently removes the item from an anime slider rather than showing it.
 */
export async function hydrateTraktTmdbIds(
  items: TraktMediaItem[],
  options: { discoverSource?: string; offline?: boolean } = {}
): Promise<TraktMediaItem[]> {
  const missing = items.filter((item) => !item.tmdbId);
  if (!missing.length) return items;
  ensureMappingLayer();

  const resolved = new Map<TraktMediaItem, number>();
  for (const item of missing) {
    for (const ref of sourceRefs(item)) {
      try {
        const resolution = await mappingService.resolve(
          ref,
          tmdbNamespace(item.mediaType),
          {
            discoverSource: options.discoverSource ?? 'trakt',
            offline: options.offline,
            title: item.title,
            year: item.year,
            mediaType: item.mediaType,
          }
        );
        const tmdbId = Number(resolution.target?.id);
        if (tmdbId > 0) {
          resolved.set(item, tmdbId);
          break;
        }
      } catch (error) {
        logger.debug('Unable to resolve Trakt item', {
          label: 'Mapping',
          trakt: item.traktSlug ?? item.traktId,
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (!resolved.size) return items;
  return items.map((item) => {
    const tmdbId = resolved.get(item);
    return tmdbId ? { ...item, tmdbId } : item;
  });
}

/**
 * Confirm the TMDB ids Trakt supplied and repair the dead ones.
 *
 * Trakt's ids measured 976/979 correct, so they are trusted rather than
 * re-derived — but "correct" and "still alive on TMDB" are different claims.
 * Both alternate-cut records in the sample (Mad Max Black & Chrome, LOTR Two
 * Towers Extended) carry ids TMDB has deleted, and they resolve to the base
 * film through the same record's IMDB id.
 */
export async function confirmTraktTmdbIds(
  items: TraktMediaItem[],
  options: { discoverSource?: string; offline?: boolean } = {}
): Promise<TraktMediaItem[]> {
  const withIds = items.filter((item) => item.tmdbId);
  if (!withIds.length) return items;

  // Fired together rather than in sequence: a page is 20 items, and the budget
  // layer already caps how many TMDB requests are in flight, so serialising
  // here would only add latency to the first render of every slider.
  const replacements = new Map<TraktMediaItem, number | undefined>();
  await Promise.all(
    withIds.map(async (item) => {
      const confirmed = await confirmOrRepair(
        {
          tmdbId: item.tmdbId,
          mediaType: item.mediaType,
          title: item.title,
          year: item.year,
          refs: sourceRefs(item),
        },
        {
          discoverSource: options.discoverSource ?? 'trakt',
          offline: options.offline,
          namespace: traktRef(item),
        }
      );
      if (confirmed) replacements.set(item, confirmed.tmdbId);
    })
  );

  if (!replacements.size) return items;
  return items.map((item) => {
    if (!replacements.has(item)) return item;
    const tmdbId = replacements.get(item);
    // Dropping the id is deliberate: an unmapped tile is honest, a card that
    // 500s when clicked is not.
    return { ...item, tmdbId };
  });
}
