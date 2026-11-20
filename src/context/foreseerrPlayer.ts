import axios from 'axios';

/**
 * Hands Jellyfin playback to Foreseerr Player, the native player app.
 *
 * Experimental and off by default. Turn it on in the browser console:
 * `localStorage.setItem('foreseerrPlayer.enabled', 'true')`.
 *
 * Every play sends the player a fresh single-use ticket in a
 * `foreseerr-player://open` link. The player plays at once when it is
 * already signed in as the ticket's user, and otherwise signs in first with
 * Jellyfin Quick Connect, which Foreseerr approves. A ticket it didn't need
 * just expires, so nothing about the pairing is kept here.
 */
const ENABLED_KEY = 'foreseerrPlayer.enabled';
const SCHEME = 'foreseerr-player';

export const foreseerrPlayerEnabled = (): boolean => {
  try {
    return window.localStorage.getItem(ENABLED_KEY) === 'true';
  } catch {
    return false;
  }
};

/**
 * Opens [itemId] in Foreseerr Player. False when the player is off, so the
 * caller keeps its browser link.
 */
export const playInForeseerrPlayer = (itemId: string): boolean => {
  if (!foreseerrPlayerEnabled()) return false;
  axios
    .post<{ ticket: string }>('/api/v1/player/pair-tickets')
    .then(({ data }) => {
      const params = new URLSearchParams({
        foreseerr: window.location.origin,
        ticket: data.ticket,
        id: itemId,
      });
      window.location.href = `${SCHEME}://open?${params}`;
    })
    .catch((e) => {
      // eslint-disable-next-line no-console
      console.error('Foreseerr Player could not be opened', e);
    });
  return true;
};
