---
title: Foreseerr v0.5.1 release notes
---

## Fixes

- Restores Library Play/Resume in the ordinary browser (overview cards were
  no-ops outside the native desktop host).
- Loads Library genre facets when Movies or Series is selected.
- Scopes proxied Jellyfin artwork to the signed-in user.
- Persists the Jellyfin session when Quick Connect creates a new user, so
  Library / Watch Now / Better Trakt work without a password login.
- Treats a missing Better Trakt Jellyfin session as unlinked instead of 500ing
  media-action capabilities and hiding every control.
- Stops episode watched writes from snapping back after a successful Trakt
  update (stale GET cache).
- Hides watched Discover titles using Jellyfin played state as well as Trakt.
- Isolates Trakt 429 cool-downs per token instead of blocking every user.
- Sends episode and ongoing requests to Sonarr even when the series is already
  Available in the library.
- Routes anime Sonarr folders/profiles/tags from anime detection, not
  `seriesType === 'anime'`.
- Keeps all-day calendar rows on the first visible day in west-of-UTC
  timezones.
- Stops episode-only requests from marking the whole series as “mine” on the
  calendar.
- Clears Servarr release lists when the episode/season target changes, and
  pages Arr queues so busy download activity is not missed.
- Maps mixed Discover genres (Family/Kids) and movie vs TV date defaults
  independently; refreshes hide-watched genre and Trakt lists after a watch.
- Denies native desktop play until the new user is ready after a session
  switch.
- Hides Quick Connect on Emby; accepts custom Plex metadata GUIDs; optional
  Gotify embed posters.

## Upgrade notes

- Upgrades from Foreseerr `v0.1.0`, `v0.2.0`, `v0.2.1`, `v0.3.0`, `v0.4.x`,
  and `v0.5.0` are supported. Back up your configuration before upgrading.
- No new database migrations are included in this release.
- Image: `ghcr.io/selmant/foreseerr:v0.5.1` (also published to Docker Hub as
  `selmantr/foreseerr:v0.5.1`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` /
  `appVersion` `0.5.1` / `v0.5.1`).

## Compatibility

- No public API removals are included.
- Downgrades are not supported.
- Supported runtimes remain Node.js `^22.19.0 || ^24.0.0`, pnpm `^10.0.0`,
  bundled SQLite, and PostgreSQL 16.
