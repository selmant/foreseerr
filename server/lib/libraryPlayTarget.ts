export interface PlayTargetEpisode {
  Id: string;
  SeriesId?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  SeriesName?: string;
  Name?: string;
  UserData?: {
    PlaybackPositionTicks?: number;
    PlayedPercentage?: number;
    Played?: boolean;
  };
}

export interface SeriesPlayTarget {
  playItemId: string;
  subtitle: string;
  progressPercent?: number;
  startPositionTicks?: number;
}

const isInProgress = (episode: PlayTargetEpisode): boolean => {
  const userData = episode.UserData;
  if (!userData || userData.Played) {
    return false;
  }
  if (
    userData.PlayedPercentage != null &&
    userData.PlayedPercentage > 0 &&
    userData.PlayedPercentage < 95
  ) {
    return true;
  }
  return (userData.PlaybackPositionTicks ?? 0) > 0;
};

const isWatched = (episode: PlayTargetEpisode): boolean => {
  if (episode.UserData?.Played) {
    return true;
  }
  return (episode.UserData?.PlayedPercentage ?? 0) >= 95;
};

const sortEpisodes = (episodes: PlayTargetEpisode[]): PlayTargetEpisode[] =>
  [...episodes].sort((a, b) => {
    const seasonDiff =
      (a.ParentIndexNumber ?? Number.MAX_SAFE_INTEGER) -
      (b.ParentIndexNumber ?? Number.MAX_SAFE_INTEGER);
    if (seasonDiff !== 0) return seasonDiff;
    return (
      (a.IndexNumber ?? Number.MAX_SAFE_INTEGER) -
      (b.IndexNumber ?? Number.MAX_SAFE_INTEGER)
    );
  });

const formatSxE = (episode: PlayTargetEpisode): string => {
  const season = episode.ParentIndexNumber;
  const number = episode.IndexNumber;
  if (season != null && number != null) {
    return `S${season}E${number}`;
  }
  return episode.Name || 'Episode';
};

const progressFromEpisode = (
  episode: PlayTargetEpisode
): number | undefined => {
  const pct = episode.UserData?.PlayedPercentage;
  if (pct == null) return undefined;
  return Math.min(100, Math.max(0, Math.round(pct)));
};

/**
 * Resolve what Play should start for a series:
 * in-progress → next unwatched → first non-special episode (rewatch).
 */
export const resolveSeriesPlayTarget = (
  seriesId: string,
  episodes: PlayTargetEpisode[],
  resumeEpisodes: PlayTargetEpisode[] = []
): SeriesPlayTarget | undefined => {
  const belonging = (episode: PlayTargetEpisode) =>
    !episode.SeriesId || episode.SeriesId === seriesId;

  const ordered = sortEpisodes(episodes.filter(belonging));
  if (ordered.length === 0) {
    return undefined;
  }

  const resumeHit = sortEpisodes(resumeEpisodes.filter(belonging)).find(
    isInProgress
  );
  if (resumeHit) {
    return {
      playItemId: resumeHit.Id,
      subtitle: `Up next ${formatSxE(resumeHit)}`,
      progressPercent: progressFromEpisode(resumeHit),
      startPositionTicks: resumeHit.UserData?.PlaybackPositionTicks,
    };
  }

  const inProgress = ordered.find(isInProgress);
  if (inProgress) {
    return {
      playItemId: inProgress.Id,
      subtitle: `Up next ${formatSxE(inProgress)}`,
      progressPercent: progressFromEpisode(inProgress),
      startPositionTicks: inProgress.UserData?.PlaybackPositionTicks,
    };
  }

  const nextUnwatched = ordered.find((episode) => !isWatched(episode));
  if (nextUnwatched) {
    return {
      playItemId: nextUnwatched.Id,
      subtitle: `Up next ${formatSxE(nextUnwatched)}`,
      progressPercent: progressFromEpisode(nextUnwatched),
      startPositionTicks: nextUnwatched.UserData?.PlaybackPositionTicks,
    };
  }

  const nonSpecial = ordered.filter(
    (episode) => (episode.ParentIndexNumber ?? 0) >= 1
  );
  const rewatch = nonSpecial[0] ?? ordered[0];
  return {
    playItemId: rewatch.Id,
    subtitle: `Rewatch ${formatSxE(rewatch)}`,
  };
};

/** Drop series with no resolved playable episode (empty or unresolved). */
export const filterPlayableLibraryTitles = <
  T extends { mediaType: 'movie' | 'tv'; playItemId?: string },
>(
  titles: T[]
): T[] =>
  titles.filter(
    (title) => title.mediaType !== 'tv' || Boolean(title.playItemId)
  );
