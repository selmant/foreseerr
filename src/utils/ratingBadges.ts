import type { RatingResponse } from '@server/api/ratings';
import type { RatingSourceToggles } from '@server/constants/ratingBadges';
import { DEFAULT_RATING_SOURCE_TOGGLES } from '@server/constants/ratingBadges';

export type RatingBadgeSource =
  | 'tmdb'
  | 'imdb'
  | 'rt'
  | 'rt-user'
  | 'metacritic'
  | 'trakt-community';

export type RtCriticsState = 'Certified Fresh' | 'Fresh' | 'Rotten';
export type RtAudienceState = 'Upright' | 'Spilled';

export interface RatingBadge {
  key: RatingBadgeSource;
  label: string;
  value: string;
  title: string;
  href?: string;
  rtCriticsRating?: RtCriticsState;
  rtAudienceRating?: RtAudienceState;
}

export interface RatingBadgeItem {
  tmdbRating?: number | null;
  ratings?: RatingResponse | null;
}

/**
 * Build provider-agnostic rating badges from TMDB + combined RatingResponse.
 */
export function buildRatingBadges(
  item: RatingBadgeItem,
  settings: RatingSourceToggles = DEFAULT_RATING_SOURCE_TOGGLES
): RatingBadge[] {
  const badges: RatingBadge[] = [];
  const ratings = item.ratings;

  // Match media-detail order: RT → audience → IMDb → Metacritic → Trakt → TMDB
  if (
    settings.showRt &&
    ratings?.rt?.criticsScore != null &&
    ratings.rt.criticsRating
  ) {
    const value = `${ratings.rt.criticsScore}%`;
    badges.push({
      key: 'rt',
      label: 'Rotten Tomatoes',
      value,
      title: `Rotten Tomatoes Tomatometer (${value})`,
      href: ratings.rt.url,
      rtCriticsRating: ratings.rt.criticsRating,
    });
  }

  if (settings.showRtUser && ratings?.rt?.audienceScore != null) {
    const value = `${ratings.rt.audienceScore}%`;
    badges.push({
      key: 'rt-user',
      label: 'Audience Score',
      value,
      title: `Rotten Tomatoes Audience Score (${value})`,
      href: ratings.rt.url,
      rtAudienceRating: ratings.rt.audienceRating,
    });
  }

  if (settings.showImdb && ratings?.imdb?.criticsScore != null) {
    const value = Number(ratings.imdb.criticsScore).toFixed(1);
    badges.push({
      key: 'imdb',
      label: 'IMDb',
      value,
      title: `IMDb (${value})`,
      href: ratings.imdb.url,
    });
  }

  if (settings.showMetacritic && ratings?.metacritic?.score != null) {
    const value = String(ratings.metacritic.score);
    badges.push({
      key: 'metacritic',
      label: 'Metacritic',
      value,
      title: `Metacritic (${value}/100)`,
    });
  }

  if (settings.showTraktCommunity && ratings?.trakt?.rating != null) {
    const value = Number(ratings.trakt.rating).toFixed(1);
    badges.push({
      key: 'trakt-community',
      label: 'Trakt',
      value,
      title: `Trakt Community Score (${value})`,
    });
  }

  if (settings.showTmdb && item.tmdbRating != null) {
    const value = `${Math.round(Number(item.tmdbRating) * 10)}%`;
    badges.push({
      key: 'tmdb',
      label: 'TMDB',
      value,
      title: `TMDB User Score (${value})`,
    });
  }

  return badges;
}
