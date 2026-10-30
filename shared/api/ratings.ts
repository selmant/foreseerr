export interface IMDBRating {
  title: string;
  url: string;
  criticsScore: number;
  criticsScoreCount: number;
}

export interface RTRating {
  title: string;
  year: number;
  criticsRating?: 'Certified Fresh' | 'Fresh' | 'Rotten';
  criticsScore?: number;
  audienceRating?: 'Upright' | 'Spilled';
  audienceScore?: number;
  url: string;
}

export interface MetacriticRating {
  score: number;
}

export interface TraktCommunityRating {
  rating: number;
  votes?: number;
}

export interface SimklCommunityRating {
  rating: number;
  votes?: number;
  url?: string;
}

/**
 * Combined ratings payload for media detail + title-card badges.
 * `provider` indicates which backend filled the data (MDBList vs legacy scrapers).
 */
export interface RatingResponse {
  provider?: 'mdblist' | 'legacy';
  rt?: RTRating;
  imdb?: IMDBRating;
  metacritic?: MetacriticRating;
  trakt?: TraktCommunityRating;
  simkl?: SimklCommunityRating;
}
