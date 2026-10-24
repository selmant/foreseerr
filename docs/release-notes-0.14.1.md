---
title: Foreseerr v0.14.1 release notes
---

## Fixes

- The first episode request sync after upgrading to `v0.14.0` no longer
  monitors and searches old watch-ahead episodes. `v0.14.0` added
  `monitoredAt` to remember which episodes Foreseerr already monitored, but
  existing episodes started without it, so the sync monitored every one that
  had no file, once. That included watched episodes a cleanup tool such as
  Maintainerr had already deleted, and Sonarr downloaded them again.
  Foreseerr now only monitors watch-ahead episodes inside the current window,
  and a migration dates existing episodes from when they were added.

## Upgrade notes

- Upgrades from earlier stable Foreseerr releases, including `v0.14.0`, are
  supported. Back up your configuration and database before upgrading.
- One new database migration, `1789700000000-BackfillWatchAheadMonitoredAt`.
  It sets `monitoredAt` to `createdAt` on watch-ahead episodes that have none.
  If you already upgraded to `v0.14.0` and the first sync re-downloaded
  episodes, this release won't undo that, but it won't happen again.
- Image: `ghcr.io/selmant/foreseerr:v0.14.1` (also published to Docker Hub as
  `selmantr/foreseerr:v0.14.1`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` /
  `appVersion` `0.14.1` / `v0.14.1`).

## Compatibility

- No endpoints were added or removed, and no API responses changed.
- Downgrades are not supported.
- Supported runtimes are Bun `>=1.4.0`, bundled SQLite, and PostgreSQL 16.
