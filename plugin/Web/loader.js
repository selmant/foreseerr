(function () {
  'use strict';

  function currentApiClient() {
    return (
      window.ApiClient ||
      (window.connectionManager &&
        window.connectionManager.currentApiClient &&
        window.connectionManager.currentApiClient()) ||
      null
    );
  }

  function authHeaders(api) {
    var headers = { Accept: 'application/json' };
    try {
      var token =
        (typeof api.accessToken === 'function' && api.accessToken()) ||
        (api._serverInfo && api._serverInfo.AccessToken);
      if (token) {
        headers.Authorization = 'MediaBrowser Token="' + token + '"';
      }
    } catch {
      /* ignore */
    }
    return headers;
  }

  // Foreseerr's eye logo, drawn in the header's own color like Jellyfin's icons.
  var ICON =
    '<svg viewBox="-10 -10 116 116" width="24" height="24" aria-hidden="true" focusable="false" style="display:block">' +
    '<path fill="currentColor" fill-rule="evenodd" d="M48 96C74.5 96 96 74.5 96 48S74.5 0 48 0 0 21.5 0 48s21.5 48 48 48Zm32-44c0 15.5-12.5 28-28 28S24 67.5 24 52c0-2.9.4-5.6 1.2-8.2C27.4 48.6 32.3 52 38 52c7.7 0 14-6.3 14-14 0-5.7-3.4-10.6-8.2-12.8 2.6-.8 5.3-1.2 8.2-1.2 15.5 0 28 12.5 28 28Z"/>' +
    '</svg>';

  // A refused account gets Foreseerr's reason; anything else is an outage.
  function signInError(res) {
    return res
      .json()
      .catch(function () {
        return {};
      })
      .then(function (body) {
        throw new Error(
          res.status === 403 && body.detail
            ? body.detail
            : 'Foreseerr sign-in is unavailable. Check the plugin status and retry.'
        );
      });
  }

  function openForeseerr() {
    var api = currentApiClient();
    if (!api) return;
    fetch(api.getUrl('Foreseerr/sso'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: authHeaders(api),
    })
      .then(function (res) {
        return res.ok ? res.json() : signInError(res);
      })
      .then(function (body) {
        window.location.href = body.url;
      })
      .catch(function (error) {
        window.alert(error.message);
      });
  }

  function isVisible(element) {
    var rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // Jellyfin 12's default layout renders a React app bar and hides the
  // legacy .skinHeader, so anchor on whichever header is on screen. The
  // search control is used because its href is not localized.
  function visibleAnchor() {
    var candidates = document.querySelectorAll(
      '.MuiToolbar-root a[href$="#/search"], .skinHeader .headerSearchButton, .skinHeader .headerCastButton'
    );
    for (var i = 0; i < candidates.length; i++) {
      if (isVisible(candidates[i])) return candidates[i];
    }
    return null;
  }

  function createButton(anchor) {
    var button = document.createElement('button');
    button.type = 'button';
    button.title = 'Foreseerr';
    button.setAttribute('aria-label', 'Foreseerr');
    button.innerHTML = ICON;
    // Borrow only styling classes; legacy header code binds to others.
    var styling = anchor.className
      .toString()
      .split(/\s+/)
      .filter(function (name) {
        return /^(Mui|css-)/.test(name);
      });
    button.className = (
      styling.length
        ? styling.join(' ')
        : 'headerButton headerButtonRight paper-icon-button-light'
    ).concat(' headerForeseerrButton');
    button.addEventListener('click', openForeseerr);
    return button;
  }

  function signedIn() {
    var api = currentApiClient();
    try {
      return !!(
        api &&
        typeof api.accessToken === 'function' &&
        api.accessToken()
      );
    } catch {
      return false;
    }
  }

  function ensureButton() {
    var existing = document.querySelector('.headerForeseerrButton');
    // The login screen also renders an app bar; SSO needs a Jellyfin session.
    if (!signedIn()) {
      if (existing) existing.remove();
      return;
    }
    if (existing && isVisible(existing)) return;
    var anchor = visibleAnchor();
    if (!anchor) return;
    if (existing) existing.remove();
    anchor.parentNode.insertBefore(createButton(anchor), anchor);
  }

  // The header is re-rendered on navigation and layout changes.
  var scheduled = false;
  new MutationObserver(function () {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      ensureButton();
    });
  }).observe(document.documentElement, { childList: true, subtree: true });
  ensureButton();
})();
