export interface TmdbSeasonCount {
  seasonNumber: number;
  episodeCount: number;
}

export function absoluteEpisodeNumber(
  seasons: TmdbSeasonCount[],
  seasonNumber: number,
  episodeNumber: number
): number | null {
  if (seasonNumber < 1 || episodeNumber < 1) {
    return null;
  }
  const season = seasons.find((entry) => entry.seasonNumber === seasonNumber);
  if (!season) {
    return null;
  }
  const prior = seasons
    .filter(
      (entry) => entry.seasonNumber > 0 && entry.seasonNumber < seasonNumber
    )
    .reduce((sum, entry) => sum + entry.episodeCount, 0);
  return prior + episodeNumber;
}

export function anilistProgressForEpisode(
  absolute: number,
  anilistEpisodeCount: number | null | undefined,
  seasonEpisodeNumber: number
): number | null {
  if (absolute < 1) {
    return null;
  }
  const cap =
    anilistEpisodeCount != null && anilistEpisodeCount > 0
      ? anilistEpisodeCount
      : null;
  if (cap == null || absolute <= cap) {
    return absolute;
  }
  if (seasonEpisodeNumber >= 1 && seasonEpisodeNumber <= cap) {
    return seasonEpisodeNumber;
  }
  return null;
}

export function watchedEpisodeNumbersForSeason(
  seasons: TmdbSeasonCount[],
  seasonNumber: number,
  progress: number,
  anilistEpisodeCount?: number | null
): number[] {
  if (seasonNumber < 1 || progress <= 0) {
    return [];
  }
  const season = seasons.find((entry) => entry.seasonNumber === seasonNumber);
  if (!season || season.episodeCount < 1) {
    return [];
  }
  const firstAbsolute = absoluteEpisodeNumber(seasons, seasonNumber, 1);
  if (firstAbsolute == null) {
    return [];
  }
  const cap =
    anilistEpisodeCount != null && anilistEpisodeCount > 0
      ? anilistEpisodeCount
      : null;
  const splitSeason = cap != null && firstAbsolute > cap;
  if (splitSeason) {
    const count = Math.min(progress, season.episodeCount, cap);
    return Array.from({ length: Math.max(0, count) }, (_, index) => index + 1);
  }
  const lastWatched = Math.min(
    progress,
    firstAbsolute + season.episodeCount - 1
  );
  if (lastWatched < firstAbsolute) {
    return [];
  }
  return Array.from(
    { length: lastWatched - firstAbsolute + 1 },
    (_, index) => index + 1
  );
}

export function nextAnilistProgress(
  currentProgress: number,
  targetProgress: number,
  watched: boolean
): number | null {
  if (targetProgress < 1) {
    return null;
  }
  if (watched) {
    return targetProgress > currentProgress ? targetProgress : null;
  }
  if (currentProgress === targetProgress) {
    return targetProgress - 1;
  }
  return null;
}

export function watchedEpisodesFromProgress(
  progress: number,
  seasonEpisodeCount: number,
  episodeOffset = 0
): number[] {
  const start = Math.max(0, episodeOffset);
  const count = Math.min(
    Math.max(0, progress),
    Math.max(0, seasonEpisodeCount - start)
  );
  if (count < 1) {
    return [];
  }
  return Array.from({ length: count }, (_, index) => start + index + 1);
}
