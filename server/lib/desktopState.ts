let playbackActive = false;
let stopping = false;
let managedDesktopRuntime = process.env.FORESEERR_RUNTIME === 'desktop';

export const setDesktopPlaybackActive = (active: boolean): void => {
  playbackActive = active;
};

export const isDesktopPlaybackActive = (): boolean => playbackActive;

export const setDesktopStopping = (value: boolean): void => {
  stopping = value;
};

export const isDesktopStopping = (): boolean => stopping;

/** Runtime mode is chosen by the managed start API, not just process env. */
export const setDesktopRuntime = (value: boolean): void => {
  managedDesktopRuntime = value;
};

export const isDesktopRuntime = (): boolean => managedDesktopRuntime;
