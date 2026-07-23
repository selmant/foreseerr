export { filterDiscoverResults, filterTraktDiscoverItems } from './browse';
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
  RequestRoutingError,
  applyResolvedRoutingToRequest,
  resolveAnimeSonarrRouting,
  resolveAtomicRequestRouting,
  resolveRequestProfileRouting,
} from './routing';
export type {
  AnimeRoutingResult,
  RequestRouteKind,
  RequestRoutingOverrides,
  ResolvedRequestRouting,
} from './routing';
export {
  DEFAULT_PROFILE_ROUTING,
  DEFAULT_REQUEST_ROUTING,
  EMPTY_PROFILE_ROUTE,
  hasProfileRouteConfig,
  normalizeProfileRoute,
  normalizeProfileRouting,
  type RequestProfileRoute,
  type RequestProfileRouting,
  type RequestRoutingSettings,
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
