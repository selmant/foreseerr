import { DEFAULT_RATING_BADGE_SETTINGS } from '@server/constants/ratingBadges';
import { MediaServerType } from '@server/constants/server';
import type { PublicSettingsResponse } from '@server/interfaces/api/settingsInterfaces';
import React from 'react';
import useSWR from 'swr';

export interface SettingsContextProps {
  currentSettings: PublicSettingsResponse;
  children?: React.ReactNode;
}

const defaultSettings = {
  initialized: false,
  applicationTitle: 'Foreseerr',
  applicationUrl: '',
  hideAvailable: false,
  hideBlocklisted: false,
  localLogin: true,
  mediaServerLogin: true,
  movie4kEnabled: false,
  series4kEnabled: false,
  movieInstantRequestEnabled: true,
  movie4kInstantRequestEnabled: true,
  seriesInstantRequestEnabled: true,
  series4kInstantRequestEnabled: true,
  discoverRegion: '',
  streamingRegion: '',
  originalLanguage: '',
  mediaServerType: MediaServerType.NOT_CONFIGURED,
  partialRequestsEnabled: true,
  episodeRequestsEnabled: false,
  enableSpecialEpisodes: false,
  cacheImages: false,
  vapidPublic: '',
  enablePushRegistration: false,
  locale: 'en',
  emailEnabled: false,
  newPlexLogin: true,
  youtubeUrl: '',
  versionCheck: true,
  plexClientIdentifier: '',
  traktConfigured: false,
  anilistConfigured: false,
  mediaActionsTraktEnabled: true,
  mediaActionsJellyfinEnabled: true,
  mediaActionsAnilistEnabled: true,
  mdblistConfigured: false,
  ratingBadges: { ...DEFAULT_RATING_BADGE_SETTINGS },
};

export const SettingsContext = React.createContext<SettingsContextProps>({
  currentSettings: defaultSettings,
});

export const SettingsProvider = ({
  children,
  currentSettings,
}: SettingsContextProps) => {
  const { data, error } = useSWR<PublicSettingsResponse>(
    '/api/v1/settings/public',
    { fallbackData: currentSettings }
  );

  let newSettings = defaultSettings;

  if (data && !error) {
    newSettings = data;
  }

  return (
    <SettingsContext.Provider value={{ currentSettings: newSettings }}>
      {children}
    </SettingsContext.Provider>
  );
};
