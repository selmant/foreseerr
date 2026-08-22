let playbackActive = false;
let stopping = false;
let managedDesktopRuntime = process.env.FORESEERR_RUNTIME === 'desktop';
let desktopApplicationUrl = '';

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
  if (!value) desktopApplicationUrl = '';
};

export const isDesktopRuntime = (): boolean => managedDesktopRuntime;

/** Keep the volatile managed loopback origin out of durable settings.json. */
export const setDesktopApplicationUrl = (origin: string): void => {
  desktopApplicationUrl = managedDesktopRuntime ? origin : '';
};

export const effectiveApplicationUrl = (persistedUrl: string): string =>
  desktopApplicationUrl || persistedUrl;
