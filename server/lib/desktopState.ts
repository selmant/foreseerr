let playbackActive = false;

export const setDesktopPlaybackActive = (active: boolean): void => {
  playbackActive = active;
};

export const isDesktopPlaybackActive = (): boolean => playbackActive;
