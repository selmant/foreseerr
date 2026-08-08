export interface LibraryPlayTarget {
  provider: 'jellyfin';
  itemId: string;
  fallbackUrl: string;
  label: string;
  quality: 'standard';
}

/** Preserve the anchor's normal browser navigation unless native admits play. */
export const handleLibraryPlayClick = (
  event: { preventDefault: () => void },
  play: (target: LibraryPlayTarget) => boolean,
  target: LibraryPlayTarget
) => {
  if (play(target)) {
    event.preventDefault();
    return true;
  }
  return false;
};
