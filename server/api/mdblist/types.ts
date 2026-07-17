/**
 * Raw MDBList media-info payload (subset we care about).
 * See https://mdblist.com/api
 */
export interface MdblistRatingEntry {
  source?: string;
  value?: number | null;
  score?: number | null;
  votes?: number | null;
}

export interface MdblistMediaPayload {
  title?: string;
  type?: string;
  ids?: {
    imdb?: string;
    trakt?: number;
    tmdb?: number;
    tvdb?: number;
  };
  ratings?: MdblistRatingEntry[];
  error?: string;
}

/**
 * Normalized multi-source ratings — provider-agnostic shape for UI badges.
 * Scales: *Rating fields on 0–10 use one decimal; percent scores are 0–100 ints.
 */
export interface ParsedMdblistRatings {
  imdbId?: string;
  imdbRating?: number;
  imdbVotes?: number;
  rtRating?: number;
  rtUserRating?: number;
  metacriticRating?: number;
  traktRating?: number;
  traktVotes?: number;
  tmdbRating?: number;
}
