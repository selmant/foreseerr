import {
  DiscoverSliderType,
  retiredDiscoverSliderTypes,
} from '@server/constants/discover';
import type DiscoverSlider from '@server/entity/DiscoverSlider';
import type { DiscoverSliderResponse } from '@server/interfaces/api/discoverInterfaces';

/**
 * English names of the built-in rows Foreseerr names itself.
 *
 * These must stay equal to `sliderTitles` in
 * `src/components/Discover/constants.ts`; the frontend strings are extracted
 * for translation from literals, so they cannot import these.
 * `sliderEndpoint.test.ts` pins the two together.
 */
export const builtInSliderTitles: Partial<Record<DiscoverSliderType, string>> =
  {
    [DiscoverSliderType.TRAKT_RECOMMENDATIONS]: 'Trakt Recommendations',
    [DiscoverSliderType.TRAKT_WATCHLIST]: 'Trakt Watchlist',
    [DiscoverSliderType.TRAKT_HISTORY]: 'Trakt History',
    [DiscoverSliderType.ANILIST_TRENDING]: 'AniList Trending',
    [DiscoverSliderType.ANILIST_SEASON]: 'AniList This Season',
    [DiscoverSliderType.ANILIST_POPULAR]: 'AniList Popular',
    [DiscoverSliderType.ANILIST_TOP]: 'AniList Top 100',
    [DiscoverSliderType.ANILIST_NEXT_SEASON]: 'AniList Next Season',
    [DiscoverSliderType.ANILIST_WATCHING]: 'AniList Watching',
    [DiscoverSliderType.ANILIST_PLANNING]: 'AniList Planning',
    [DiscoverSliderType.ANILIST_COMPLETED]: 'AniList Completed',
    [DiscoverSliderType.SIMKL_TRENDING]: 'Simkl Trending',
    [DiscoverSliderType.SIMKL_PLAN_TO_WATCH]: 'Simkl Plan to Watch',
    [DiscoverSliderType.SIMKL_WATCHING]: 'Simkl Watching',
    [DiscoverSliderType.SIMKL_ON_HOLD]: 'Simkl On Hold',
    [DiscoverSliderType.SIMKL_COMPLETED]: 'Simkl Completed',
    [DiscoverSliderType.SIMKL_DROPPED]: 'Simkl Dropped',
  };

const API = '/api/v1';

/**
 * `encodeURIComponent` leaves `!'()*` alone, and the API validator rejects
 * query values that still contain reserved characters (a list named
 * `Rewatch (2024)` would 400). Same idea as the frontend's
 * `encodeURIExtraParams`.
 */
export const encodeQueryValue = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );

const withQuery = (
  path: string,
  params: Record<string, string> = {}
): string => {
  const query = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeQueryValue(value)}`)
    .join('&');
  return query ? `${path}?${query}` : path;
};

/**
 * Provider tiles that did not map to TMDB cannot be opened by a client that
 * works from TMDB ids, so every provider endpoint asks the server to drop them.
 */
const provider = (path: string, params: Record<string, string> = {}) =>
  withQuery(`${API}/discover/${path}`, { ...params, hideUnmapped: 'true' });

const simklLibrary = (status: string) => provider('simkl/library', { status });

/** Built-in provider rows: one fixed route each. */
const fixedEndpoints: Partial<Record<DiscoverSliderType, string>> = {
  [DiscoverSliderType.TRAKT_RECOMMENDATIONS]: provider('trakt/recommendations'),
  [DiscoverSliderType.TRAKT_WATCHLIST]: provider('trakt/watchlist'),
  [DiscoverSliderType.TRAKT_HISTORY]: provider('trakt/history'),
  [DiscoverSliderType.ANILIST_TRENDING]: provider('anilist/trending'),
  [DiscoverSliderType.ANILIST_SEASON]: provider('anilist/season'),
  [DiscoverSliderType.ANILIST_POPULAR]: provider('anilist/popular'),
  [DiscoverSliderType.ANILIST_TOP]: provider('anilist/top'),
  [DiscoverSliderType.ANILIST_NEXT_SEASON]: provider('anilist/next-season'),
  [DiscoverSliderType.ANILIST_WATCHING]: provider('anilist/watching'),
  [DiscoverSliderType.ANILIST_PLANNING]: provider('anilist/planning'),
  [DiscoverSliderType.ANILIST_COMPLETED]: provider('anilist/completed'),
  [DiscoverSliderType.SIMKL_TRENDING]: provider('simkl/trending'),
  [DiscoverSliderType.SIMKL_PLAN_TO_WATCH]: simklLibrary('plantowatch'),
  [DiscoverSliderType.SIMKL_WATCHING]: simklLibrary('watching'),
  [DiscoverSliderType.SIMKL_ON_HOLD]: simklLibrary('hold'),
  [DiscoverSliderType.SIMKL_COMPLETED]: simklLibrary('completed'),
  [DiscoverSliderType.SIMKL_DROPPED]: simklLibrary('dropped'),
};

/**
 * The API path and query a client calls for one page of a slider, without
 * `page` (append `page=N` with `&`, or `?` when there is no query yet).
 *
 * Mirrors what `src/components/Discover/index.tsx` and the provider slider
 * components fetch. Undefined for the rows clients draw themselves (types
 * 1–12), for retired types, and for custom rows missing the `data` they need.
 */
export function discoverSliderEndpoint(
  slider: Pick<DiscoverSlider, 'type' | 'data'>
): string | undefined {
  if (retiredDiscoverSliderTypes.has(slider.type)) return undefined;

  const fixed = fixedEndpoints[slider.type];
  if (fixed) return fixed;

  const data = slider.data?.trim();
  if (!data) return undefined;

  switch (slider.type) {
    case DiscoverSliderType.TMDB_MOVIE_KEYWORD:
      return withQuery(`${API}/discover/movies`, { keywords: data });
    case DiscoverSliderType.TMDB_TV_KEYWORD:
      return withQuery(`${API}/discover/tv`, { keywords: data });
    case DiscoverSliderType.TMDB_MOVIE_GENRE:
      return withQuery(`${API}/discover/movies`, { genre: data });
    case DiscoverSliderType.TMDB_TV_GENRE:
      return withQuery(`${API}/discover/tv`, { genre: data });
    case DiscoverSliderType.TMDB_SEARCH:
      return withQuery(`${API}/search`, { query: data });
    case DiscoverSliderType.TMDB_STUDIO:
      return `${API}/discover/movies/studio/${encodeQueryValue(data)}`;
    case DiscoverSliderType.TMDB_NETWORK:
      return `${API}/discover/tv/network/${encodeQueryValue(data)}`;
    case DiscoverSliderType.TMDB_MOVIE_STREAMING_SERVICES:
    case DiscoverSliderType.TMDB_TV_STREAMING_SERVICES: {
      // `data` is `<region>,<provider ids joined by |>`.
      const [watchRegion, watchProviders] = data
        .split(',')
        .map((part) => part.trim());
      if (!watchRegion || !watchProviders) return undefined;
      return withQuery(
        `${API}/discover/${
          slider.type === DiscoverSliderType.TMDB_MOVIE_STREAMING_SERVICES
            ? 'movies'
            : 'tv'
        }`,
        { watchRegion, watchProviders }
      );
    }
    case DiscoverSliderType.TRAKT_LIST:
      return provider('trakt/list', { url: data });
    case DiscoverSliderType.ANILIST_LIST:
      return provider('anilist/list', { name: data });
    case DiscoverSliderType.MDBLIST_LIST:
      return provider('mdblist/list', { url: data });
    default:
      return undefined;
  }
}

/** English name of a built-in row Foreseerr names itself. */
export function discoverSliderDefaultTitle(
  type: DiscoverSliderType
): string | undefined {
  return builtInSliderTitles[type];
}

/**
 * The slider as `GET /settings/discover` returns it. `endpoint` and
 * `defaultTitle` are computed per response and are never columns: the result
 * is a plain object, not an entity, so it cannot be saved back by accident.
 */
export function toDiscoverSliderResponse(
  slider: DiscoverSlider
): DiscoverSliderResponse {
  const endpoint = discoverSliderEndpoint(slider);
  const defaultTitle = discoverSliderDefaultTitle(slider.type);
  return {
    ...slider,
    ...(endpoint ? { endpoint } : {}),
    ...(defaultTitle ? { defaultTitle } : {}),
  };
}
