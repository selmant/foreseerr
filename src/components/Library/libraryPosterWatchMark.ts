export type LibraryWatchMark =
  | 'unplayed'
  | 'watched'
  | 'progress'
  | 'remaining';

export const isLibrarySeriesPoster = (item: {
  mediaType?: 'movie' | 'tv';
  jellyfinItemId?: string;
  jellyfinSeriesId?: string;
}): boolean =>
  item.mediaType === 'tv' &&
  Boolean(item.jellyfinSeriesId) &&
  item.jellyfinItemId === item.jellyfinSeriesId;

export const libraryWatchMark = (item: {
  mediaType?: 'movie' | 'tv';
  jellyfinItemId?: string;
  jellyfinSeriesId?: string;
  watched?: boolean;
  inProgress?: boolean;
  progressPercent?: number;
  unplayedItemCount?: number;
  lastPlayedAt?: string;
}): LibraryWatchMark => {
  if (isLibrarySeriesPoster(item)) {
    if (item.watched || item.unplayedItemCount === 0) {
      return 'watched';
    }
    if (item.unplayedItemCount != null && item.unplayedItemCount > 0) {
      return 'remaining';
    }
    return 'unplayed';
  }

  const progress = item.progressPercent ?? 0;
  if (item.inProgress || (progress > 0 && progress < 95)) {
    return 'progress';
  }
  if (item.watched) {
    return 'watched';
  }
  return 'unplayed';
};

export const showLibraryUnplayedPip = (
  item: Parameters<typeof libraryWatchMark>[0]
): boolean => libraryWatchMark(item) === 'unplayed';
