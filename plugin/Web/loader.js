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
        (api && typeof api.accessToken === 'function' && api.accessToken()) ||
        (api && api._serverInfo && api._serverInfo.AccessToken);
      if (token) {
        headers.Authorization = 'MediaBrowser Token="' + token + '"';
      }
    } catch {
      /* ignore */
    }
    return headers;
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
        if (!res.ok)
          throw new Error(
            'Foreseerr sign-in is unavailable. Check the plugin status and retry.'
          );
        return res.json();
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
    button.innerHTML =
      '<span style="font-weight:700;font-size:13px;letter-spacing:.04em">F</span>';
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
