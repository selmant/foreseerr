export interface ProductionCompany {
  id: number;
  logoPath?: string;
  originCountry: string;
  name: string;
  description?: string;
  headquarters?: string;
  homepage?: string;
}

export interface TvNetwork {
  id: number;
  logoPath?: string;
  originCountry?: string;
  name: string;
  headquarters?: string;
  homepage?: string;
}

export interface Keyword {
  id: number;
  name: string;
}

export interface Genre {
  id: number;
  name: string;
}

export interface Cast {
  id: number;
  castId: number;
  character: string;
  creditId: string;
  gender?: number;
  name: string;
  order: number;
  profilePath?: string;
}

export interface Crew {
  id: number;
  creditId: string;
  department: string;
  gender?: number;
  job: string;
  name: string;
  profilePath?: string;
}

export interface ExternalIds {
  imdbId?: string;
  freebaseMid?: string;
  freebaseId?: string;
  tvdbId?: number;
  tvrageId?: string;
  facebookId?: string;
  instagramId?: string;
  twitterId?: string;
}

export interface WatchProviders {
  iso_3166_1: string;
  link?: string;
  buy?: WatchProviderDetails[];
  flatrate?: WatchProviderDetails[];
}

export interface WatchProviderDetails {
  displayPriority?: number;
  logoPath?: string;
  id: number;
  name: string;
}
