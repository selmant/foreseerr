import MdblistAPI from '@server/api/mdblist';
import {
  DEFAULT_RATING_BADGE_SETTINGS,
  needsVisibleMdblistBadges,
  type RatingBadgeSettings,
} from '@server/constants/ratingBadges';
import cacheManager from '@server/lib/cache';
import {
  hasBrowseQueryFilters,
  needsMdblistBrowseFilters,
  parseBrowseQueryFilters,
} from '@server/lib/requestFilters/query';
import { getSettings } from '@server/lib/settings';
import type { Request } from 'express';
import type { ParsedUrlQuery } from 'querystring';

export type EnrichRatingsQuery = Request['query'] | ParsedUrlQuery;

export type EnrichRatingsOptions = {
  /** When set, also consider active browse filters that require MDBList. */
  query?: EnrichRatingsQuery;
  /** Skip items that already have a `ratings` property (avoids duplicate passes). */
  skipExisting?: boolean;
  /** Bypass badge/filter gating (explicit ratings endpoints). */
  force?: boolean;
};

const resolveBadgeSettings = (
  overrides?: Partial<RatingBadgeSettings>
): RatingBadgeSettings => ({
  ...DEFAULT_RATING_BADGE_SETTINGS,
  ...getSettings().mdblist,
  ...overrides,
});

/** Whether automatic MDBList enrichment should run for this request. */
export const needsMdblistEnrichment = (
  query?: EnrichRatingsQuery,
  badgeSettings?: Partial<RatingBadgeSettings>
): boolean => {
  if (!getSettings().mdblist?.apiKey?.trim()) {
    return false;
  }

  if (needsVisibleMdblistBadges(resolveBadgeSettings(badgeSettings))) {
    return true;
  }

  if (query) {
    const filters = parseBrowseQueryFilters(query);
    if (hasBrowseQueryFilters(filters) && needsMdblistBrowseFilters(filters)) {
      return true;
    }
  }

  return false;
};

/** Drop cached ratings and reset the shared MDBList client after credential changes. */
export const clearMdblistProviderState = (): void => {
  cacheManager.getCache('mdblist').flush();
  MdblistAPI.resetInstance();
};
