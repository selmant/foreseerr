import type { MediaRequest } from '@server/entity/MediaRequest';
import type { PaginatedResponse } from '@server/interfaces/api/common';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import axios from 'axios';
import useSWR from 'swr';

/** How many posters a See More card collages. */
const POSTER_COUNT = 4;

type PageRequest = Pick<MediaRequest, 'type' | 'media'>;

type RequestPage = PaginatedResponse & { results: PageRequest[] };

/** The title route RequestCard reads a request's poster from. */
const titleUrl = (request: PageRequest) =>
  request.type === 'movie'
    ? `/api/v1/movie/${request.media.tmdbId}`
    : `/api/v1/tv/${request.media.tmdbId}`;

const fetchPosters = (urls: string[]) =>
  Promise.allSettled(
    urls.map((url) => axios.get<MovieDetails | TvDetails>(url))
  ).then((titles) =>
    titles.map((title) =>
      title.status === 'fulfilled' ? title.value.data.posterPath : undefined
    )
  );

/**
 * Posters for a request slider's See More card, taken from the requests after
 * the row's page so the card previews requests the row does not contain.
 * `endpoint` is the row's request route without `take` and `skip`. Returns
 * nothing when there are no further requests.
 */
const useRequestSeeMorePosters = (
  endpoint: string | null,
  firstPage: RequestPage | undefined
): (string | undefined)[] | undefined => {
  const pageInfo = firstPage?.pageInfo;
  const { data: nextPage } = useSWR<RequestPage>(
    endpoint && pageInfo && pageInfo.page < pageInfo.pages
      ? `${endpoint}${endpoint.includes('?') ? '&' : '?'}take=${POSTER_COUNT}&skip=${pageInfo.page * pageInfo.pageSize}`
      : null
  );
  const { data: posters } = useSWR(
    nextPage?.results.length ? nextPage.results.map(titleUrl) : null,
    fetchPosters
  );

  return posters;
};

export default useRequestSeeMorePosters;
