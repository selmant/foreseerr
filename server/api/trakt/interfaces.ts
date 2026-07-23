export interface TraktIds {
  trakt?: number;
  slug?: string;
  imdb?: string;
  tmdb?: number;
  tvdb?: number;
}

export interface TraktMediaObject {
  title?: string;
  name?: string;
  year?: number;
  ids?: TraktIds;
  /** Community rating 0–10 when fetched with extended=full */
  rating?: number;
  votes?: number;
  released?: string;
  first_aired?: string;
}

export interface TraktListEntry {
  type?: string;
  movie?: TraktMediaObject;
  show?: TraktMediaObject;
  episode?: TraktMediaObject;
  watched_at?: string;
  rating?: number;
  listed_at?: string;
}

/** Stable browse filter for Trakt discover routes. */
export type TraktBrowseMediaType = 'movie' | 'tv' | 'anime' | 'all';

/** Trakt API fetch scope (movies and/or shows). */
export type TraktFetchMediaType = 'movie' | 'tv' | 'all';

export type TraktListSortBy = 'added' | 'released';

export interface TraktMediaItem {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  title: string;
  year?: number;
  /** Community rating from Trakt extended=full payloads */
  traktCommunityRating?: number;
  /** Trakt list metadata used for app-side list sorting. */
  traktAddedAt?: string;
  traktReleaseDate?: string;
}

export interface TraktUserList {
  name?: string;
  title?: string;
  slug?: string;
  description?: string;
  privacy?: string;
  item_count?: number;
  ids?: TraktIds;
  user?: {
    username?: string;
    slug?: string;
    ids?: TraktIds;
  };
}

export interface TraktLikedList {
  liked_at?: string;
  list?: TraktUserList;
}

export interface TraktDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

export interface TraktTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  created_at?: number;
  token_type?: string;
  scope?: string;
}

export interface TraktTokenState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface TraktUserSettingsResponse {
  user?: {
    username?: string;
    name?: string;
    slug?: string;
    ids?: {
      slug?: string;
      uuid?: string;
      trakt?: number;
    };
  };
}

export interface TraktListMetadata {
  id: string;
  slug: string;
  name: string;
  itemCount: number;
  privacy?: string;
  username?: string;
  isWatchlist?: boolean;
  isLiked?: boolean;
}

export interface TraktSearchListEntry {
  type?: string;
  list?: TraktUserList;
}

export type TraktDevicePollResult =
  | { status: 'authorized'; tokens: TraktTokenResponse & { expiresAt: number } }
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'already_used' }
  | { status: 'invalid' }
  | { status: 'expired' }
  | { status: 'denied' };
