---
title: Foreseerr v0.13.3 release notes
---

## Fixes

- Watch-ahead requests no longer monitor episodes again after their files were
  deleted. When a cleanup tool such as Maintainerr deleted and unmonitored a
  watched episode, the episode request sync monitored it again, and anything
  that grabs monitored missing episodes downloaded it once more. An episode
  Foreseerr already saw downloaded now stays unmonitored once its file is gone,
  and no search is started for it. Episodes that were never downloaded are
  still monitored and searched as before.

## Upgrade notes

- Upgrades from earlier stable Foreseerr releases, including `v0.13.2`, are
  supported. Back up your configuration and database before upgrading.
- No new database migrations since `v0.13.2`.
- Image: `ghcr.io/selmant/foreseerr:v0.13.3` (also published to Docker Hub as
  `selmantr/foreseerr:v0.13.3`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` /
  `appVersion` `0.13.3` / `v0.13.3`).

## Compatibility

- No endpoints were added or removed, and no API responses changed.
- Downgrades are not supported.
- Supported runtimes are Bun `>=1.4.0`, bundled SQLite, and PostgreSQL 16.
