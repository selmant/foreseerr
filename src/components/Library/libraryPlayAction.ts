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

/**
 * After an async inspector lookup we already preventDefault, so the browser
 * will not follow href. Send the user to Jellyfin when native play is denied.
 */
export const shouldNavigatePlayFallback = (
  nativeAdmitted: boolean,
  alreadyPreventedDefault: boolean,
  fallbackUrl: string
): boolean =>
  !nativeAdmitted && alreadyPreventedDefault && Boolean(fallbackUrl);

export const navigatePlayFallback = (fallbackUrl: string): void => {
  if (typeof window === 'undefined' || !fallbackUrl) {
    return;
  }
  window.location.assign(fallbackUrl);
};
