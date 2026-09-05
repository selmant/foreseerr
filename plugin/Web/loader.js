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
        headers['X-Emby-Token'] = token;
        headers.Authorization = 'MediaBrowser Token="' + token + '"';
      }
    } catch {
      /* ignore */
    }
    return headers;
  }

  function openForeseerr() {
    var api = currentApiClient();
    fetch('/ForeseerrPlugin/sso', {
      method: 'POST',
      credentials: 'same-origin',
      headers: authHeaders(api),
    })
      .then(function (res) {
        return res.ok ? res.json() : { url: '/Foreseerr/' };
      })
      .then(function (body) {
        window.location.href = (body && body.url) || '/Foreseerr/';
      })
      .catch(function () {
        window.location.href = '/Foreseerr/';
      });
  }

  function addButton() {
    if (document.querySelector('.headerForeseerrButton')) {
      return;
    }
    var cast = document.querySelector(
      '.headerCastButton, .btnCast, .headerRight'
    );
    var button = document.createElement('button');
    button.type = 'button';
    button.className =
      'headerButton headerButtonRight headerForeseerrButton paper-icon-button-light';
    button.title = 'Foreseerr';
    button.setAttribute('aria-label', 'Foreseerr');
    button.innerHTML =
      '<span style="font-weight:700;font-size:13px;letter-spacing:.04em">F</span>';
    button.addEventListener('click', openForeseerr);
    if (cast && cast.parentNode) {
      cast.parentNode.insertBefore(button, cast);
    } else {
      var header = document.querySelector(
        '.skinHeader, .headerRight, .mainDrawer'
      );
      if (header) {
        header.appendChild(button);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addButton);
  } else {
    addButton();
  }
  setTimeout(addButton, 1500);
})();
