import TheMovieDb from '@server/api/themoviedb';
import type { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';

export const createTmdbWithRegionLanguage = (user?: User): TheMovieDb => {
  const settings = getSettings();
  const discoverRegion =
    user?.settings?.streamingRegion === 'all'
      ? ''
      : user?.settings?.streamingRegion
        ? user.settings.streamingRegion
        : settings.main.discoverRegion;
  const originalLanguage =
    user?.settings?.originalLanguage === 'all'
      ? ''
      : user?.settings?.originalLanguage
        ? user.settings.originalLanguage
        : settings.main.originalLanguage;

  return new TheMovieDb({ discoverRegion, originalLanguage });
};

export const createTmdbWithBlocklistSettings = (): TheMovieDb => {
  const settings = getSettings();
  return new TheMovieDb({
    discoverRegion: settings.main.blocklistRegion,
    originalLanguage: settings.main.blocklistLanguage,
  });
};
