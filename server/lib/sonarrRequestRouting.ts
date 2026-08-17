import type { SonarrSeries } from '@server/api/servarr/sonarr';
import { MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { SonarrSettings } from '@server/lib/settings';

export function hasEpisodeSelection(
  entity: Pick<MediaRequest, 'episodes' | 'episodeSelectionType'>
): boolean {
  return Boolean(
    entity.episodeSelectionType ||
    (entity.episodes && entity.episodes.length > 0)
  );
}

export function shouldShortCircuitAvailableTvRequest(
  entity: Pick<MediaRequest, 'is4k' | 'episodes' | 'episodeSelectionType'>,
  media: Pick<Media, 'status' | 'status4k'>
): boolean {
  if (media[entity.is4k ? 'status4k' : 'status'] !== MediaStatus.AVAILABLE) {
    return false;
  }
  return !hasEpisodeSelection(entity);
}

export function resolveSonarrSeriesRouting(
  sonarrSettings: SonarrSettings,
  isAnime: boolean
): {
  seriesType: SonarrSeries['seriesType'];
  rootFolder: string;
  qualityProfile: number;
  languageProfile: number | undefined;
  tags: number[];
} {
  // seriesType only controls how Sonarr parses/numbers episodes.
  // Anime folder/profile/tags must follow isAnime, not seriesType.
  let seriesType: SonarrSeries['seriesType'] =
    sonarrSettings.seriesType ?? 'standard';
  if (isAnime) {
    seriesType = sonarrSettings.animeSeriesType ?? 'anime';
  }

  return {
    seriesType,
    rootFolder:
      isAnime && sonarrSettings.activeAnimeDirectory
        ? sonarrSettings.activeAnimeDirectory
        : sonarrSettings.activeDirectory,
    qualityProfile:
      isAnime && sonarrSettings.activeAnimeProfileId
        ? sonarrSettings.activeAnimeProfileId
        : sonarrSettings.activeProfileId,
    languageProfile:
      isAnime && sonarrSettings.activeAnimeLanguageProfileId
        ? sonarrSettings.activeAnimeLanguageProfileId
        : sonarrSettings.activeLanguageProfileId,
    tags: isAnime
      ? sonarrSettings.animeTags
        ? [...sonarrSettings.animeTags]
        : []
      : sonarrSettings.tags
        ? [...sonarrSettings.tags]
        : [],
  };
}
