import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import axios from 'axios';
import { useCallback } from 'react';
import { useIntl } from 'react-intl';

/**
 * Hands Jellyfin playback to the Foreseerr app's own player. Only inside the
 * app (Foreseerr's page in its window); a browser keeps Jellyfin's links.
 *
 * Every play sends the app a fresh single-use ticket in a
 * `foreseerr-player://open` link, which the app takes instead of loading.
 * It plays at once when it is already signed in as the ticket's user, and
 * otherwise redeems the ticket for the user's linked Jellyfin session and
 * signs in with it. A ticket it didn't need just expires, so nothing about
 * the pairing is kept here.
 */
const SCHEME = 'foreseerr-player';

const messages = defineMessages('context.foreseerrPlayer', {
  notLinked:
    'Link your Jellyfin account in your profile settings to play here.',
  rateLimited: 'Too many plays at once. Try again in a minute.',
  playFailed: 'The player could not be opened: {error}',
});

/** What the app puts on `window` in its own pages. */
interface ForeseerrPlayerHost {
  version: number;
  request: (message: Record<string, unknown>) => Promise<unknown>;
}

declare global {
  interface Window {
    foreseerrPlayer?: ForeseerrPlayerHost;
  }
}

/** The app around this page, if there is one. */
export const foreseerrPlayerHost = (): ForeseerrPlayerHost | undefined =>
  typeof window !== 'undefined' &&
  typeof window.foreseerrPlayer?.request === 'function'
    ? window.foreseerrPlayer
    : undefined;

const ticket = async (): Promise<string> =>
  (await axios.post<{ ticket: string }>('/api/v1/player/pair-tickets')).data
    .ticket;

/** The latest play; an earlier one finishing late must not replace it. */
let latestPlay = 0;

/**
 * Opens [itemId] in the app's player. False outside the app, so the caller
 * keeps its browser link. When the ticket can't be had, [onError] gets the
 * server's error code (or the error's message).
 */
export const playInForeseerrPlayer = (
  itemId: string,
  onError?: (code: string) => void
): boolean => {
  if (!foreseerrPlayerHost()) return false;
  const play = ++latestPlay;
  ticket()
    .then((value) => {
      if (play !== latestPlay) return;
      const params = new URLSearchParams({
        foreseerr: window.location.origin,
        ticket: value,
        id: itemId,
      });
      window.location.href = `${SCHEME}://open?${params}`;
    })
    .catch((e) => {
      if (play !== latestPlay) return;
      // eslint-disable-next-line no-console
      console.error('The player could not be opened', e);
      const code = axios.isAxiosError(e)
        ? (e.response?.data as { code?: string } | undefined)?.code
        : undefined;
      onError?.(code ?? (e instanceof Error ? e.message : String(e)));
    });
  return true;
};

/** What a play button plays, and the link it falls back to. */
export interface PlayTarget {
  provider: 'jellyfin' | 'emby' | 'plex' | 'trailer';
  itemId?: string;
  fallbackUrl: string;
  label: string;
  quality: 'standard' | '4k' | 'trailer';
}

/**
 * `play(target)` for play buttons: plays a Jellyfin item in the app's player
 * for a signed-in user and answers true, or answers false so the button
 * keeps its link (outside the app, or anything else).
 */
export const usePlayInApp = (): ((target: PlayTarget) => boolean) => {
  const { user, error } = useUser();
  const intl = useIntl();
  const { addToast } = useToasts();
  const signedIn = !error && !!user;
  return useCallback(
    (target: PlayTarget) =>
      signedIn &&
      target.provider === 'jellyfin' &&
      !!target.itemId &&
      playInForeseerrPlayer(target.itemId, (code) =>
        addToast(
          code === 'not_linked'
            ? intl.formatMessage(messages.notLinked)
            : code === 'rate_limited'
              ? intl.formatMessage(messages.rateLimited)
              : intl.formatMessage(messages.playFailed, { error: code }),
          { appearance: 'error', autoDismiss: true }
        )
      ),
    [addToast, intl, signedIn]
  );
};

/**
 * The player's own settings, as the app describes them. The app builds this
 * from its settings screens, so new player settings show up here without
 * changes to Foreseerr.
 */
export interface PlayerSettingOption {
  value: string | number;
  label: string;
}

interface PlayerSettingBase {
  key: string;
  title: string;
  description?: string | null;
  enabled: boolean;
}

export type PlayerSetting = PlayerSettingBase &
  (
    | { type: 'switch'; value: boolean }
    | {
        type: 'choice';
        value: string | number | null;
        options: PlayerSettingOption[];
      }
    | {
        type: 'multi';
        value: string[];
        options: PlayerSettingOption[];
        max: number | null;
        emptyLabel: string;
      }
    | {
        type: 'slider';
        value: number;
        min: number;
        max: number;
        step: number;
        label: string;
        labels?: Record<string, string>;
      }
  );

export interface PlayerSettingsSection {
  title: string | null;
  settings: PlayerSetting[];
}

export interface PlayerSettingsPage {
  path: string[];
  sections: PlayerSettingsSection[];
}

export interface PlayerSettingsSchema {
  version: 1;
  pages: PlayerSettingsPage[];
}

/** The app answers this when it has never signed in to Jellyfin. */
export const PLAYER_NOT_PAIRED = 'not_paired';

const host = (): ForeseerrPlayerHost => {
  const found = foreseerrPlayerHost();
  if (!found) throw new Error('not in the Foreseerr app');
  return found;
};

export const getPlayerSettings = async (): Promise<PlayerSettingsSchema> =>
  (await host().request({ type: 'settings' })) as PlayerSettingsSchema;

/** Sets one setting; resolves with all of them as they are after it. */
export const setPlayerSetting = async (
  key: string,
  value: unknown
): Promise<PlayerSettingsSchema> =>
  (await host().request({
    type: 'setSetting',
    key,
    value,
  })) as PlayerSettingsSchema;

/** Quits the app. */
export const quitApp = async (): Promise<void> => {
  await host().request({ type: 'quit' });
};

/** Clears the app's web cache (its HTTP cache, not cookies or storage). */
export const clearAppCache = async (): Promise<void> => {
  await host().request({ type: 'clearCache' });
};

/** Shows the app's setup page, to open another Foreseerr server. */
export const changeAppAddress = async (): Promise<void> => {
  await host().request({ type: 'changeAddress' });
};

/** Signs the player in as this user, as a first play would. */
export const pairPlayer = async (): Promise<boolean> =>
  (await host().request({ type: 'pair', ticket: await ticket() })) === true;
