---
title: Foreseerr v0.13.4 release notes
---

## Fixes

- Watch-ahead requests no longer search for a completed episode whose file was
  deleted while Sonarr still monitors it. The `v0.13.3` fix kept such episodes
  unmonitored, but an episode that stayed monitored after its file was removed
  was still searched, so it could be downloaded again. Completed episodes are
  now never searched by the episode request sync. Episodes that were never
  downloaded are still monitored and searched as before.

## Upgrade notes

- Upgrades from earlier stable Foreseerr releases, including `v0.13.3`, are
  supported. Back up your configuration and database before upgrading.
- No new database migrations since `v0.13.3`.
- Image: `ghcr.io/selmant/foreseerr:v0.13.4` (also published to Docker Hub as
  `selmantr/foreseerr:v0.13.4`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` /
  `appVersion` `0.13.4` / `v0.13.4`).

## Compatibility

- No endpoints were added or removed, and no API responses changed.
- Downgrades are not supported.
- Supported runtimes are Bun `>=1.4.0`, bundled SQLite, and PostgreSQL 16.
