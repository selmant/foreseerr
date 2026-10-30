import type { RatingResponse } from '@shared/api/ratings';
import type Media from '@shared/entity/Media';

export interface PersonDetails {
  id: number;
  name: string;
  birthday: string;
  deathday: string;
  knownForDepartment: string;
  alsoKnownAs?: string[];
  gender: number;
  biography: string;
  popularity: number;
  placeOfBirth?: string;
  profilePath?: string;
  adult: boolean;
  imdbId?: string;
  homepage?: string;
}

export interface PersonCredit {
  id: number;
  originalLanguage: string;
  episodeCount: number;
  overview: string;
  originCountry: string[];
  originalName: string;
  voteCount: number;
  name: string;
  mediaType?: string;
  popularity: number;
  creditId: string;
  backdropPath?: string;
  firstAirDate: string;
  voteAverage: number;
  genreIds?: number[];
  posterPath?: string;
  originalTitle: string;
  video?: boolean;
  title: string;
  adult: boolean;
  releaseDate: string;
  mediaInfo?: Media;
  ratings?: RatingResponse | null;
}

export interface PersonCreditCast extends PersonCredit {
  character: string;
}

export interface PersonCreditCrew extends PersonCredit {
  department: string;
  job: string;
}

export interface CombinedCredit {
  id: number;
  cast: PersonCreditCast[];
  crew: PersonCreditCrew[];
}
