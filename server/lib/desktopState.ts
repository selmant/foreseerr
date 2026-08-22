let playbackActive = false;
let stopping = false;

export const setDesktopPlaybackActive = (active: boolean): void => {
  playbackActive = active;
};

export const isDesktopPlaybackActive = (): boolean => playbackActive;

export const setDesktopStopping = (value: boolean): void => {
  stopping = value;
};

export const isDesktopStopping = (): boolean => stopping;
