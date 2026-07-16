import { type IMDBRating } from '@server/api/rating/imdbRadarrProxy';
import { type RTRating } from '@server/api/rating/rottentomatoes';

export interface MetacriticRating {
  score: number;
}

export interface TraktCommunityRating {
  rating: number;
  votes?: number;
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
}
