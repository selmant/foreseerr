import defineMessages from '@app/utils/defineMessages';
import type { ParsedUrlQuery } from 'querystring';
import { z } from 'zod';

type AvailableColors =
  | 'black'
  | 'red'
  | 'darkred'
  | 'blue'
  | 'lightblue'
  | 'darkblue'
  | 'orange'
  | 'darkorange'
  | 'green'
  | 'lightgreen'
  | 'purple'
  | 'darkpurple'
  | 'yellow'
  | 'pink';

export const colorTones: Record<AvailableColors, [string, string]> = {
  red: ['991B1B', 'FCA5A5'],
  darkred: ['1F2937', 'F87171'],
  blue: ['032541', '01b4e4'],
  lightblue: ['1F2937', '60A5FA'],
  darkblue: ['1F2937', '2864d2'],
  orange: ['92400E', 'FCD34D'],
  lightgreen: ['065F46', '6EE7B7'],
  green: ['087d29', '21cb51'],
  purple: ['5B21B6', 'C4B5FD'],
  yellow: ['777e0d', 'e4ed55'],
  darkorange: ['552c01', 'd47c1d'],
  black: ['1F2937', 'D1D5DB'],
  pink: ['9D174D', 'F9A8D4'],
  darkpurple: ['480c8b', 'a96bef'],
};

export const genreColorMap: Record<number, [string, string]> = {
  0: colorTones.black,
  28: colorTones.red, // Action
  12: colorTones.darkpurple, // Adventure
  16: colorTones.blue, // Animation
  35: colorTones.orange, // Comedy
  80: colorTones.darkblue, // Crime
  99: colorTones.lightgreen, // Documentary
  18: colorTones.pink, // Drama
  10751: colorTones.yellow, // Family
  14: colorTones.lightblue, // Fantasy
  36: colorTones.orange, // History
  27: colorTones.black, // Horror
  10402: colorTones.blue, // Music
  9648: colorTones.purple, // Mystery
  10749: colorTones.pink, // Romance
  878: colorTones.lightblue, // Science Fiction
  10770: colorTones.red, // TV Movie
  53: colorTones.black, // Thriller
  10752: colorTones.darkred, // War
  37: colorTones.orange, // Western
  10759: colorTones.darkpurple, // Action & Adventure
  10762: colorTones.blue, // Kids
  10763: colorTones.black, // News
  10764: colorTones.darkorange, // Reality
  10765: colorTones.lightblue, // Sci-Fi & Fantasy
  10766: colorTones.pink, // Soap
  10767: colorTones.lightgreen, // Talk
  10768: colorTones.darkred, // War & Politics
};

export const sliderTitles = defineMessages('components.Discover', {
  recentrequests: 'Recent Requests',
  popularmovies: 'Popular Movies',
  populartv: 'Popular Series',
  upcomingtv: 'Upcoming Series',
  recentlyAdded: 'Recently Added',
  upcoming: 'Upcoming Movies',
  trending: 'Trending',
  plexwatchlist: 'Your Watchlist',
  moviegenres: 'Movie Genres',
  tvgenres: 'Series Genres',
  studios: 'Studios',
  networks: 'Networks',
  tmdbmoviekeyword: 'TMDB Movie Keyword',
  tmdbtvkeyword: 'TMDB Series Keyword',
  tmdbmoviegenre: 'TMDB Movie Genre',
  tmdbtvgenre: 'TMDB Series Genre',
  tmdbnetwork: 'TMDB Network',
  tmdbstudio: 'TMDB Studio',
  tmdbsearch: 'TMDB Search',
  tmdbmoviestreamingservices: 'TMDB Movie Streaming Services',
  tmdbtvstreamingservices: 'TMDB TV Streaming Services',
  traktrecommendations: 'Trakt Recommendations',
  traktwatchlist: 'Trakt Watchlist',
  traktlist: 'Trakt List',
  trakthistory: 'Trakt History',
  anilisttrending: 'AniList Trending',
  anilistseason: 'AniList This Season',
  anilistpopular: 'AniList Popular',
  anilisttop: 'AniList Top 100',
  anilistnextseason: 'AniList Next Season',
  anilistwatching: 'AniList Watching',
  anilistplanning: 'AniList Planning',
  anilistcompleted: 'AniList Completed',
  anilistlist: 'AniList List',
  mdblistlist: 'MDBList List',
  simkltrending: 'Simkl Trending',
  simklplantowatch: 'Simkl Plan to Watch',
  simklwatching: 'Simkl Watching',
  simklonhold: 'Simkl On Hold',
  simklcompleted: 'Simkl Completed',
  simkldropped: 'Simkl Dropped',
});

export const QueryFilterOptions = z.object({
  sortBy: z.string().optional(),
  primaryReleaseDateGte: z.string().optional(),
  primaryReleaseDateLte: z.string().optional(),
  firstAirDateGte: z.string().optional(),
  firstAirDateLte: z.string().optional(),
  studio: z.string().optional(),
  genre: z.string().optional(),
  keywords: z.string().optional(),
  excludeKeywords: z.string().optional(),
  language: z.string().optional(),
  withRuntimeGte: z.string().optional(),
  withRuntimeLte: z.string().optional(),
  voteAverageGte: z.string().optional(),
  voteAverageLte: z.string().optional(),
  voteCountLte: z.string().optional(),
  voteCountGte: z.string().optional(),
  watchRegion: z.string().optional(),
  watchProviders: z.string().optional(),
  status: z.string().optional(),
  certification: z.string().optional(),
  certificationGte: z.string().optional(),
  certificationLte: z.string().optional(),
  certificationCountry: z.string().optional(),
  certificationMode: z.enum(['exact', 'range']).optional(),
  ignoreWatched: z.enum(['true', 'false']).optional(),
  ignoreCollected: z.string().optional(),
  ignoreWatchlisted: z.string().optional(),
  hideUnmapped: z.enum(['true', 'false']).optional(),
  /** MDBList extras — rating ranges (unset = off) */
  imdbRatingGte: z.string().optional(),
  imdbRatingLte: z.string().optional(),
  imdbVotesGte: z.string().optional(),
  imdbVotesLte: z.string().optional(),
  rtCriticsGte: z.string().optional(),
  rtCriticsLte: z.string().optional(),
  rtAudienceGte: z.string().optional(),
  rtAudienceLte: z.string().optional(),
  metacriticGte: z.string().optional(),
  metacriticLte: z.string().optional(),
  traktRatingGte: z.string().optional(),
  traktRatingLte: z.string().optional(),
  /** When 'false', hide titles missing a required external rating */
  includeNoRating: z.enum(['true', 'false']).optional(),
});

export type FilterOptions = z.infer<typeof QueryFilterOptions>;

export type DiscoverRangeSpec = {
  id:
    | 'imdbRating'
    | 'imdbVotes'
    | 'rtCritics'
    | 'rtAudience'
    | 'metacritic'
    | 'traktRating';
  keyGte: keyof FilterOptions;
  keyLte: keyof FilterOptions;
  min: number;
  max: number;
  step?: number;
};

/** Shared range semantics for the Discover page and saved user defaults. */
export const discoverRangeFilters = [
  {
    id: 'imdbRating',
    keyGte: 'imdbRatingGte',
    keyLte: 'imdbRatingLte',
    min: 1,
    max: 10,
    step: 0.1,
  },
  {
    id: 'imdbVotes',
    keyGte: 'imdbVotesGte',
    keyLte: 'imdbVotesLte',
    min: 0,
    max: 100000,
  },
  {
    id: 'rtCritics',
    keyGte: 'rtCriticsGte',
    keyLte: 'rtCriticsLte',
    min: 0,
    max: 100,
  },
  {
    id: 'rtAudience',
    keyGte: 'rtAudienceGte',
    keyLte: 'rtAudienceLte',
    min: 0,
    max: 100,
  },
  {
    id: 'metacritic',
    keyGte: 'metacriticGte',
    keyLte: 'metacriticLte',
    min: 0,
    max: 100,
  },
  {
    id: 'traktRating',
    keyGte: 'traktRatingGte',
    keyLte: 'traktRatingLte',
    min: 1,
    max: 10,
    step: 0.1,
  },
] as const satisfies readonly DiscoverRangeSpec[];

export const formatDiscoverRangeValue = (
  value: number,
  spec: DiscoverRangeSpec
): string => (spec.step != null ? value.toFixed(1) : value.toString());

export const prepareFilterValues = (
  inputValues: ParsedUrlQuery
): FilterOptions => {
  const filterValues: FilterOptions = {};

  const values = QueryFilterOptions.parse(inputValues);

  if (values.sortBy) {
    filterValues.sortBy = values.sortBy;
  }

  if (values.primaryReleaseDateGte) {
    filterValues.primaryReleaseDateGte = values.primaryReleaseDateGte;
  }

  if (values.primaryReleaseDateLte) {
    filterValues.primaryReleaseDateLte = values.primaryReleaseDateLte;
  }

  if (values.firstAirDateGte) {
    filterValues.firstAirDateGte = values.firstAirDateGte;
  }

  if (values.firstAirDateLte) {
    filterValues.firstAirDateLte = values.firstAirDateLte;
  }

  if (values.studio) {
    filterValues.studio = values.studio;
  }

  if (values.genre) {
    filterValues.genre = values.genre;
  }

  if (values.status) {
    filterValues.status = values.status;
  }

  if (values.keywords) {
    filterValues.keywords = values.keywords;
  }

  if (values.excludeKeywords) {
    filterValues.excludeKeywords = values.excludeKeywords;
  }

  if (values.language) {
    filterValues.language = values.language;
  }

  if (values.withRuntimeGte) {
    filterValues.withRuntimeGte = values.withRuntimeGte;
  }

  if (values.withRuntimeLte) {
    filterValues.withRuntimeLte = values.withRuntimeLte;
  }

  if (values.voteAverageGte) {
    filterValues.voteAverageGte = values.voteAverageGte;
  }

  if (values.voteAverageLte) {
    filterValues.voteAverageLte = values.voteAverageLte;
  }

  if (values.voteCountGte) {
    filterValues.voteCountGte = values.voteCountGte;
  }

  if (values.voteCountLte) {
    filterValues.voteCountLte = values.voteCountLte;
  }

  if (values.watchProviders) {
    filterValues.watchProviders = values.watchProviders;
  }

  if (values.watchRegion) {
    filterValues.watchRegion = values.watchRegion;
  }

  if (values.certification) {
    filterValues.certification = values.certification;
  }

  if (values.certificationGte) {
    filterValues.certificationGte = values.certificationGte;
  }

  if (values.certificationLte) {
    filterValues.certificationLte = values.certificationLte;
  }

  if (values.certificationCountry) {
    filterValues.certificationCountry = values.certificationCountry;
  }

  if (values.certificationMode) {
    filterValues.certificationMode = values.certificationMode;
  } else if (values.certification) {
    filterValues.certificationMode = 'exact';
  } else if (values.certificationGte || values.certificationLte) {
    filterValues.certificationMode = 'range';
  }

  if (values.ignoreWatched) {
    filterValues.ignoreWatched = values.ignoreWatched;
  }

  if (values.ignoreCollected) {
    filterValues.ignoreCollected = values.ignoreCollected;
  }

  if (values.ignoreWatchlisted) {
    filterValues.ignoreWatchlisted = values.ignoreWatchlisted;
  }

  if (values.hideUnmapped) {
    filterValues.hideUnmapped = values.hideUnmapped;
  }

  if (values.imdbRatingGte) {
    filterValues.imdbRatingGte = values.imdbRatingGte;
  }
  if (values.imdbRatingLte) {
    filterValues.imdbRatingLte = values.imdbRatingLte;
  }
  if (values.imdbVotesGte) {
    filterValues.imdbVotesGte = values.imdbVotesGte;
  }
  if (values.imdbVotesLte) {
    filterValues.imdbVotesLte = values.imdbVotesLte;
  }
  if (values.rtCriticsGte) {
    filterValues.rtCriticsGte = values.rtCriticsGte;
  }
  if (values.rtCriticsLte) {
    filterValues.rtCriticsLte = values.rtCriticsLte;
  }
  if (values.rtAudienceGte) {
    filterValues.rtAudienceGte = values.rtAudienceGte;
  }
  if (values.rtAudienceLte) {
    filterValues.rtAudienceLte = values.rtAudienceLte;
  }
  if (values.metacriticGte) {
    filterValues.metacriticGte = values.metacriticGte;
  }
  if (values.metacriticLte) {
    filterValues.metacriticLte = values.metacriticLte;
  }
  if (values.traktRatingGte) {
    filterValues.traktRatingGte = values.traktRatingGte;
  }
  if (values.traktRatingLte) {
    filterValues.traktRatingLte = values.traktRatingLte;
  }
  if (values.includeNoRating) {
    filterValues.includeNoRating = values.includeNoRating;
  }

  return filterValues;
};

export const countActiveFilters = (filterValues: FilterOptions): number => {
  let totalCount = 0;
  const clonedFilters = Object.assign({}, filterValues);

  if (clonedFilters.voteAverageGte || filterValues.voteAverageLte) {
    totalCount += 1;
    delete clonedFilters.voteAverageGte;
    delete clonedFilters.voteAverageLte;
  }

  if (clonedFilters.voteCountGte || filterValues.voteCountLte) {
    totalCount += 1;
    delete clonedFilters.voteCountGte;
    delete clonedFilters.voteCountLte;
  }

  if (clonedFilters.withRuntimeGte || filterValues.withRuntimeLte) {
    totalCount += 1;
    delete clonedFilters.withRuntimeGte;
    delete clonedFilters.withRuntimeLte;
  }

  if (clonedFilters.imdbRatingGte || filterValues.imdbRatingLte) {
    totalCount += 1;
    delete clonedFilters.imdbRatingGte;
    delete clonedFilters.imdbRatingLte;
  }

  if (clonedFilters.imdbVotesGte || filterValues.imdbVotesLte) {
    totalCount += 1;
    delete clonedFilters.imdbVotesGte;
    delete clonedFilters.imdbVotesLte;
  }

  if (clonedFilters.rtCriticsGte || filterValues.rtCriticsLte) {
    totalCount += 1;
    delete clonedFilters.rtCriticsGte;
    delete clonedFilters.rtCriticsLte;
  }

  if (clonedFilters.rtAudienceGte || filterValues.rtAudienceLte) {
    totalCount += 1;
    delete clonedFilters.rtAudienceGte;
    delete clonedFilters.rtAudienceLte;
  }

  if (clonedFilters.metacriticGte || filterValues.metacriticLte) {
    totalCount += 1;
    delete clonedFilters.metacriticGte;
    delete clonedFilters.metacriticLte;
  }

  if (clonedFilters.traktRatingGte || filterValues.traktRatingLte) {
    totalCount += 1;
    delete clonedFilters.traktRatingGte;
    delete clonedFilters.traktRatingLte;
  }

  if (clonedFilters.watchProviders) {
    totalCount += 1;
    delete clonedFilters.watchProviders;
    delete clonedFilters.watchRegion;
  }

  if (
    clonedFilters.certification ||
    clonedFilters.certificationGte ||
    clonedFilters.certificationLte ||
    clonedFilters.certificationCountry
  ) {
    totalCount += 1;
    delete clonedFilters.certification;
    delete clonedFilters.certificationGte;
    delete clonedFilters.certificationLte;
    delete clonedFilters.certificationCountry;
  }

  delete clonedFilters.certificationMode;

  // Trakt toggles are counted by FilterSlideover when those sections are shown.
  delete clonedFilters.ignoreWatched;
  delete clonedFilters.ignoreCollected;
  delete clonedFilters.ignoreWatchlisted;
  delete clonedFilters.hideUnmapped;

  if (clonedFilters.includeNoRating === 'false') {
    totalCount += 1;
  }
  delete clonedFilters.includeNoRating;

  totalCount += Object.keys(clonedFilters).length;

  return totalCount;
};
