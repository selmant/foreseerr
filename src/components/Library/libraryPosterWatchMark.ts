export const showLibraryUnplayedPip = (item: {
  watched?: boolean;
  inProgress?: boolean;
  progressPercent?: number;
}): boolean =>
  !item.watched &&
  !item.inProgress &&
  !(item.progressPercent != null && item.progressPercent > 0);
