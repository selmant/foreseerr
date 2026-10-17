import type { WatchlistResponse } from '@server/interfaces/api/discoverInterfaces';
import useSWR from 'swr';

type PagedTitles = Pick<WatchlistResponse, 'hasMore' | 'totalPages'> & {
  page?: number;
};

/** Same continuation rule as `useDiscover`: `hasMore` wins over totals. */
const hasNextPage = (data: PagedTitles): boolean =>
  typeof data.hasMore === 'boolean'
    ? data.hasMore
    : data.totalPages != null && (data.page ?? 1) < data.totalPages;

/**
 * Posters for a slider's See More card, taken from the page after the one the
 * row shows so the card previews titles the row does not contain. Returns
 * nothing when the source has no further page.
 */
const useSeeMorePosters = (
  endpoint: string | null,
  firstPage: PagedTitles | undefined,
  hideRequested = false
): (string | undefined)[] | undefined => {
  const { data } = useSWR<WatchlistResponse>(
    endpoint && firstPage && hasNextPage(firstPage)
      ? `${endpoint}${endpoint.includes('?') ? '&' : '?'}page=${(firstPage.page ?? 1) + 1}`
      : null
  );
  const titles = hideRequested
    ? data?.results.filter((item) => !item.hasActiveRequest)
    : data?.results;

  return titles?.map((item) => item.image || item.posterPath);
};

export default useSeeMorePosters;
