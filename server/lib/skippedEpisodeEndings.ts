import type { JellyfinLibraryItemExtended } from '@server/api/jellyfin';

export const episodeProgress = (
  episode: JellyfinLibraryItemExtended
): number | undefined => {
  const percentage = episode.UserData?.PlayedPercentage;
  if (percentage != null) {
    return typeof percentage === 'number' && Number.isFinite(percentage)
      ? Math.max(0, Math.min(100, percentage))
      : undefined;
  }
  const position = episode.UserData?.PlaybackPositionTicks;
  const runtime = episode.UserData?.RunTimeTicks ?? episode.RunTimeTicks;
  if (
    !(
      typeof position === 'number' &&
      typeof runtime === 'number' &&
      runtime > 0
    )
  )
    return undefined;
  return Math.max(0, Math.min(100, (position / runtime) * 100));
};

const coordinate = (
  item: JellyfinLibraryItemExtended
): [number, number] | undefined =>
  typeof item.ParentIndexNumber === 'number' &&
  Number.isFinite(item.ParentIndexNumber) &&
  typeof item.IndexNumber === 'number' &&
  Number.isFinite(item.IndexNumber) &&
  item.ParentIndexNumber >= 1 &&
  item.IndexNumber >= 0
    ? [item.ParentIndexNumber, item.IndexNumber]
    : undefined;

const viewed = (item: JellyfinLibraryItemExtended): boolean =>
  item.UserData?.Played === true ||
  (item.UserData?.PlayedPercentage ?? 0) > 0 ||
  (item.UserData?.PlaybackPositionTicks ?? 0) > 0;

export function isStaleSkippedEpisode(
  candidate: JellyfinLibraryItemExtended,
  seriesEpisodes: JellyfinLibraryItemExtended[]
): boolean {
  if (
    candidate.Type !== 'Episode' ||
    candidate.UserData?.Played === true ||
    !candidate.SeriesId
  )
    return false;
  const current = coordinate(candidate);
  const progress = episodeProgress(candidate);
  if (!current || progress == null || progress < 50) return false;
  return seriesEpisodes.some((episode) => {
    if (
      episode.Type !== 'Episode' ||
      episode.SeriesId !== candidate.SeriesId ||
      !viewed(episode)
    )
      return false;
    const next = coordinate(episode);
    return (
      !!next &&
      (next[0] > current[0] || (next[0] === current[0] && next[1] > current[1]))
    );
  });
}

export type { JellyfinLibraryItemExtended };
