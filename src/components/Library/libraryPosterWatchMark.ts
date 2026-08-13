export type LibraryWatchMark = 'unplayed' | 'watched' | 'progress';

export const libraryWatchMark = (item: {
  watched?: boolean;
  inProgress?: boolean;
  progressPercent?: number;
}): LibraryWatchMark => {
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
