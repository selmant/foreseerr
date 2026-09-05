---
title: Foreseerr v0.7.1 release notes
---

## Fixes

- Puts TMDB `posterPath` on mapped Simkl Discover tiles so clients that draw
  the list payload (not TmdbTitleCard) show posters.
- Puts TMDB `posterPath` on mapped Discover list tiles (Trakt, AniList,
  MDBList) so clients do not have to fetch movie details per card.
- Does not let a hung MDBList origin blank Discover posters.
- Drops Simkl Best and Premieres Discover rows (those APIs have no ids).
- Applies the anime quality profile and tags on instant TV requests.
- Confirms manual imports in-app so the native CEF shell can submit them and
  does not trap clicks under a stuck overlay.
- Stops serving `index.html` for missing hashed assets so stale caches do not
  blank the SPA.
- Bundles the datepicker CJS build so Vite does not emit `require()`.
- Always emits `dist/launcher.js` in production builds.

## Features

- Migrates the frontend to a Vite SPA with React Router.
- Keeps N unwatched episodes requested as you watch (watch-ahead).

## Upgrade notes

- Upgrades from Foreseerr `v0.1.0`, `v0.2.0`, `v0.2.1`, `v0.3.0`, `v0.4.x`,
  `v0.5.x`, `v0.6.x`, and `v0.7.0` are supported. Back up your configuration
  before upgrading.
- Database migration `AddWatchAheadEpisodeRequests` adds watch-ahead episode
  request settings. Startup applies it automatically.
- Image: `ghcr.io/selmant/foreseerr:v0.7.1` (also published to Docker Hub as
  `selmantr/foreseerr:v0.7.1`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` /
  `appVersion` `0.7.1` / `v0.7.1`).

## Compatibility

- No public API removals are included. `posterPath` on mapped list tiles is
  additive.
- Downgrades are not supported.
- Supported runtimes are Bun `>=1.4.0`, bundled SQLite, and PostgreSQL 16.
