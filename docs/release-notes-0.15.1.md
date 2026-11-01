---
title: Foreseerr v0.15.1 release notes
---

## Fixes

- Watch-ahead episodes are no longer downloaded again after a cleanup app
  deletes them. This happened when the cleanup app deleted an episode's file
  but left the episode monitored in Sonarr. Maintainerr's season delete does
  that, and releases before `v0.14.1` re-monitored such episodes themselves.
  Sonarr's RSS sync then grabbed the episode again as soon as a new release
  appeared, sometimes weeks later. Foreseerr now unmonitors such an episode
  once. If you monitor it again in Sonarr, Foreseerr leaves it alone. It also
  leaves the episode alone if another approved request is for the same
  series, because that request may still want it.

## Upgrade notes

- Upgrades from earlier stable Foreseerr releases, including `v0.15.0`, are
  supported on SQLite and PostgreSQL. Back up your configuration and database
  before upgrading.
- No new database migrations.
- The first episode request sync after upgrading unmonitors episodes that are
  already in this state. The log lists them for each request.
- Image: `ghcr.io/selmant/foreseerr:v0.15.1` (also published to Docker Hub as
  `selmantr/foreseerr:v0.15.1`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` /
  `appVersion` `0.15.1` / `v0.15.1`).

## Compatibility

- No endpoints were added or removed. When Foreseerr unmonitors a watch-ahead
  episode this way, it clears the episode's `monitoredAt`.
- Downgrades are not supported.
- Supported runtimes are the published image and server archives, bundled
  SQLite, and PostgreSQL 16 or newer.
