import { MediaStatus } from '@server/constants/media';
import type Season from '@server/entity/Season';

export interface ProcessableSeason {
  seasonNumber: number;
  totalEpisodes: number;
  episodes: number;
  episodes4k: number;
  is4kOverride?: boolean;
  processing?: boolean;
}

export function nextSeasonStatus(options: {
  previous?: MediaStatus;
  totalEpisodes: number;
  availableEpisodes: number;
  canBeAvailable: boolean;
  processingForQuality: boolean;
  processing?: boolean;
}): MediaStatus {
  const {
    previous,
    totalEpisodes,
    availableEpisodes,
    canBeAvailable,
    processingForQuality,
    processing,
  } = options;
  if (
    canBeAvailable &&
    totalEpisodes === availableEpisodes &&
    availableEpisodes > 0
  ) {
    return MediaStatus.AVAILABLE;
  }
  // An availability scanner must not downgrade a completed season reported by
  // another scanner while library data is transiently incomplete.
  if (previous === MediaStatus.AVAILABLE) {
    return MediaStatus.AVAILABLE;
  }
  if (canBeAvailable && availableEpisodes > 0) {
    return MediaStatus.PARTIALLY_AVAILABLE;
  }
  if (processingForQuality && processing && previous !== MediaStatus.DELETED) {
    return MediaStatus.PROCESSING;
  }
  if (
    previous !== undefined &&
    processingForQuality &&
    !processing &&
    availableEpisodes === 0 &&
    previous === MediaStatus.PROCESSING
  ) {
    return MediaStatus.UNKNOWN;
  }
  return previous ?? MediaStatus.UNKNOWN;
}

/** Roll season state up to its title state for one quality profile. */
export function rollupShowStatus(options: {
  seasons: Season[];
  scannedSeasons: ProcessableSeason[];
  statusKey: 'status' | 'status4k';
  previous: MediaStatus | undefined;
  enabled: boolean;
}): MediaStatus {
  const nonSpecial = options.seasons.filter(
    (season) => season.seasonNumber !== 0
  );
  const rollupSeasons = nonSpecial.filter((season) => {
    const scanned = options.scannedSeasons.find(
      (item) => item.seasonNumber === season.seasonNumber
    );
    return scanned
      ? scanned.totalEpisodes > 0
      : season[options.statusKey] !== MediaStatus.UNKNOWN;
  });
  const allAvailable =
    rollupSeasons.length > 0 &&
    rollupSeasons.every(
      (season) => season[options.statusKey] === MediaStatus.AVAILABLE
    );
  if (options.enabled && allAvailable) return MediaStatus.AVAILABLE;
  if (
    options.enabled &&
    options.seasons.some((season) => {
      const status = season[options.statusKey];
      return (
        status === MediaStatus.PARTIALLY_AVAILABLE ||
        status === MediaStatus.AVAILABLE
      );
    })
  ) {
    return MediaStatus.PARTIALLY_AVAILABLE;
  }
  if (
    (!options.scannedSeasons.length &&
      options.previous !== MediaStatus.DELETED) ||
    options.seasons.some(
      (season) => season[options.statusKey] === MediaStatus.PROCESSING
    )
  ) {
    return MediaStatus.PROCESSING;
  }
  return options.previous === MediaStatus.DELETED
    ? MediaStatus.DELETED
    : MediaStatus.UNKNOWN;
}
