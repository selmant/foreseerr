import type { SonarrSettings } from '@server/lib/settings';
import type { RequestFiltersSettings } from './types';

export type AnimeRoutingResult = {
  server: SonarrSettings | null;
  serverId: number | null;
  profileId: number | undefined;
  rootFolder: string | undefined;
  languageProfileId: number | undefined;
  tags: number[] | undefined;
  seriesType: SonarrSettings['animeSeriesType'] | 'anime';
};

/**
 * Resolve Sonarr target for anime TV: optional dedicated anime server,
 * otherwise the default Sonarr server for the quality tier.
 */
export const resolveAnimeSonarrRouting = ({
  sonarr,
  filters,
  is4k,
  isAnime,
}: {
  sonarr: SonarrSettings[];
  filters: RequestFiltersSettings;
  is4k: boolean;
  isAnime: boolean;
}): AnimeRoutingResult | null => {
  if (!isAnime) {
    return null;
  }

  const dedicatedId = is4k
    ? filters.animeSonarrServerId4k
    : filters.animeSonarrServerId;

  let server: SonarrSettings | undefined;

  if (dedicatedId != null) {
    server = sonarr.find((s) => s.id === dedicatedId && s.is4k === is4k);
  }

  if (!server) {
    server = sonarr.find((s) => s.isDefault && s.is4k === is4k);
  }

  if (!server) {
    return null;
  }

  return {
    server,
    serverId: server.id,
    profileId: server.activeAnimeProfileId ?? server.activeProfileId,
    rootFolder: server.activeAnimeDirectory ?? server.activeDirectory,
    languageProfileId:
      server.activeAnimeLanguageProfileId ?? server.activeLanguageProfileId,
    tags: server.animeTags ? [...server.animeTags] : server.tags,
    seriesType: server.animeSeriesType ?? 'anime',
  };
};
