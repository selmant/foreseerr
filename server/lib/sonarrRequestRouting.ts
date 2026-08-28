import type { SonarrSeries } from '@server/api/servarr/sonarr';
import { MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import { findEpisodeRules } from '@server/lib/mapping/episodes';
import type { SonarrSettings } from '@server/lib/settings';
import logger from '@server/logger';

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

/**
 * Translate requested TMDB season numbers into the seasons Sonarr will actually
 * monitor.
 *
 * Sonarr organises a series by TVDB's seasons, which for anime and for split
 * seasons routinely disagree with TMDB's: requesting "season 1" of a show TVDB
 * splits into three cours otherwise monitors a third of what the user asked for.
 * Falls back to the requested numbers when no rule covers the show, so
 * non-anime shows behave exactly as before.
 */
export async function resolveSonarrSeasons(
  tmdbId: number,
  seasonNumbers: number[]
): Promise<number[]> {
  const resolved = new Set<number>();

  for (const seasonNumber of seasonNumbers) {
    let mapped = false;
    try {
      const rules = await findEpisodeRules(
        { ns: 'tmdb_show', id: String(tmdbId), season: seasonNumber },
        'tvdb_show'
      );
      for (const rule of rules) {
        if (rule.target.season === undefined) continue;
        resolved.add(rule.target.season);
        mapped = true;
      }
    } catch (error) {
      logger.debug('Unable to translate Sonarr seasons', {
        label: 'Sonarr',
        tmdbId,
        seasonNumber,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
    if (!mapped) resolved.add(seasonNumber);
  }

  return [...resolved].sort((left, right) => left - right);
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
