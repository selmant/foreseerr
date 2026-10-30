import type { RatingResponse } from '@shared/api/ratings';
import type { TmdbTvRatingResult } from '@shared/api/themoviedb/interfaces';
import type Media from '@shared/entity/Media';
import type { Video } from './Movie';
import type {
  Cast,
  Crew,
  ExternalIds,
  Genre,
  Keyword,
  ProductionCompany,
  TvNetwork,
  WatchProviders,
} from './common';

interface Episode {
  id: number;
  name: string;
  airDate: string | null;
  episodeNumber: number;
  overview: string;
  productionCode: string;
  seasonNumber: number;
  showId: number;
  stillPath?: string;
  voteAverage: number;
  voteCount: number;
}

interface Season {
  airDate: string;
  id: number;
  episodeCount: number;
  name: string;
  overview: string;
  posterPath?: string;
  seasonNumber: number;
}

export interface SeasonWithEpisodes extends Omit<Season, 'episodeCount'> {
  episodes: Episode[];
  externalIds: ExternalIds;
}

interface SpokenLanguage {
  englishName: string;
  iso_639_1: string;
  name: string;
}

export interface TvDetails {
  id: number;
  backdropPath?: string;
  posterPath?: string;
  contentRatings: TmdbTvRatingResult;
  createdBy: {
    id: number;
    name: string;
    gender: number;
    profilePath?: string;
  }[];
  episodeRunTime: number[];
  firstAirDate?: string;
  genres: Genre[];
  homepage: string;
  inProduction: boolean;
  relatedVideos?: Video[];
  languages: string[];
  lastAirDate: string;
  lastEpisodeToAir?: Episode;
  name: string;
  nextEpisodeToAir?: Episode;
  networks: TvNetwork[];
  numberOfEpisodes: number;
  numberOfSeasons: number;
  originCountry: string[];
  originalLanguage: string;
  originalName: string;
  overview: string;
  popularity: number;
  productionCompanies: ProductionCompany[];
  productionCountries: {
    iso_3166_1: string;
    name: string;
  }[];
  spokenLanguages: SpokenLanguage[];
  seasons: Season[];
  status: string;
  tagline?: string;
  type: string;
  voteAverage: number;
  voteCount: number;
  credits: {
    cast: Cast[];
    crew: Crew[];
  };
  externalIds: ExternalIds;
  keywords: Keyword[];
  mediaInfo?: Media;
  watchProviders?: WatchProviders[];
  onUserWatchlist?: boolean;
  ratings?: RatingResponse | null;
  episodeRequestsEnabled?: boolean;
}
