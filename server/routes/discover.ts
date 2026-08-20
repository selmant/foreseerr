import {
  applyDiscoverFilterDefaultsToQuery,
  safeParseDiscoverFilterDefaults,
} from '@server/lib/discover/filterDefaults';
import { parseDiscoverTruthyQuery } from '@server/lib/discover/filterOptions';
import { Router } from 'express';
import anilistDiscoverRoutes from './discover/anilist';
import mdblistDiscoverRoutes from './discover/mdblist';
import plexDiscoverRoutes from './discover/plex';
import tmdbDiscoverRoutes from './discover/tmdb';
import traktDiscoverRoutes from './discover/trakt';

const discoverRoutes = Router();

/** Apply per-user Discover filter defaults before dispatching to providers. */
discoverRoutes.use((req, _res, next) => {
  if (parseDiscoverTruthyQuery(req.query.ignoreDiscoverDefaults)) {
    return next();
  }
  req.query = applyDiscoverFilterDefaultsToQuery(
    req.query,
    safeParseDiscoverFilterDefaults(req.user?.settings?.discoverFilterDefaults)
  );
  next();
});

// Keep the established /api/v1/discover path contract while each provider
// owns its handlers and provider-specific behavior.
discoverRoutes.use('/anilist', anilistDiscoverRoutes);
discoverRoutes.use('/mdblist', mdblistDiscoverRoutes);
discoverRoutes.use('/watchlist', plexDiscoverRoutes);
discoverRoutes.use(tmdbDiscoverRoutes);
discoverRoutes.use('/trakt', traktDiscoverRoutes);

export default discoverRoutes;
