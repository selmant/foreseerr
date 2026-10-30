import {
  browseStateFromQuery,
  libraryBrowseApiPath,
} from '@app/components/Library/browseUrlState';
import type {
  LibraryBrowseResponse,
  LibraryTitle,
} from '@shared/interfaces/api/libraryInterfaces';
import useSWR from 'swr';

/** How many posters a See More card collages. */
const POSTER_COUNT = 4;

/** The browse page's first page size, so the preview shares its cache entry. */
const BROWSE_PAGE_SIZE = 24;

/** The browse API's largest page. */
const MAX_TAKE = 50;

/** Keys a shelf item and a browse title share when they are the same title. */
const titleKeys = (item: LibraryTitle): string[] =>
  [
    item.jellyfinItemId,
    item.jellyfinSeriesId,
    item.tmdbId != null ? `${item.mediaType}-${item.tmdbId}` : undefined,
  ].filter((key): key is string => Boolean(key));

/**
 * Posters for a library shelf's See More card, taken from the browse view the
 * card opens and skipping titles the shelf already shows, so the card previews
 * what the shelf does not contain. Returns nothing when every browse title is
 * already on the shelf.
 */
const useLibrarySeeMorePosters = (
  href: string | undefined,
  items: LibraryTitle[]
): (string | undefined)[] | undefined => {
  const { data } = useSWR<LibraryBrowseResponse>(
    href
      ? libraryBrowseApiPath({
          ...browseStateFromQuery(
            Object.fromEntries(new URLSearchParams(href.split('?')[1] ?? ''))
          ),
          take: Math.min(
            MAX_TAKE,
            Math.max(BROWSE_PAGE_SIZE, items.length + POSTER_COUNT)
          ),
          skip: 0,
        })
      : null
  );
  if (!data || data.code) return undefined;

  const shown = new Set(items.flatMap(titleKeys));
  return data.results
    .filter((title) => !titleKeys(title).some((key) => shown.has(key)))
    .slice(0, POSTER_COUNT)
    .map((title) => title.posterUrl);
};

export default useLibrarySeeMorePosters;
