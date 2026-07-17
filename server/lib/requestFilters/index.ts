export { filterDiscoverResults, filterTraktDiscoverItems } from './browse';
export {
  RequestEligibilityError,
  evaluateRequestEligibility,
  isEligibleForDiscover,
} from './eligibility';
export type { EligibilityMediaInput } from './eligibility';
export {
  hasBrowseQueryFilters,
  needsMdblistBrowseFilters,
  needsNonTraktMdblistBrowseFilters,
  needsTmdbBrowseFilters,
  needsTraktRatingBrowseFilters,
  parseBrowseQueryFilters,
  type BrowseQueryFilters,
} from './query';
export {
  applyResolvedRoutingToRequest,
  resolveAnimeSonarrRouting,
  resolveRequestProfileRouting,
} from './routing';
export type {
  AnimeRoutingResult,
  RequestRouteKind,
  ResolvedRequestRouting,
} from './routing';
export {
  DEFAULT_PROFILE_ROUTING,
  DEFAULT_REQUEST_FILTERS,
  EMPTY_PROFILE_ROUTE,
  hasAnyQualityGate,
  hasProfileRouteConfig,
  needsMdblistRatings,
  normalizeProfileRoute,
  normalizeProfileRouting,
  type RequestFiltersSettings,
  type RequestProfileRoute,
  type RequestProfileRouting,
} from './types';

import type { Request } from 'express';
import type { ParsedUrlQuery } from 'querystring';
import {
  needsTraktRatingBrowseFilters,
  parseBrowseQueryFilters,
} from './query';

/** Use Trakt extended=full when browse filters need community ratings. */
export const traktExtendedForBrowseQuery = (
  query: Request['query'] | ParsedUrlQuery
): 'min' | 'full' =>
  needsTraktRatingBrowseFilters(parseBrowseQueryFilters(query))
    ? 'full'
    : 'min';
