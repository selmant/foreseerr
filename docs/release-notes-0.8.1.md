---
title: Foreseerr v0.8.1 release notes
---

## Fixes

- Queues scheduled jobs that miss a concurrency slot instead of dropping them.
  Watch-ahead episode sync shares `:00` / `:15` / `:30` / `:45` with other
  jobs and was silently skipped, so enrolled series did not slide until a
  manual job run.

## Upgrade notes

- Upgrades from Foreseerr `v0.1.0`, `v0.2.0`, `v0.2.1`, `v0.3.0`, `v0.4.x`,
  `v0.5.x`, `v0.6.x`, `v0.7.x`, and `v0.8.0` are supported. Back up your
  configuration before upgrading.
- No new database migrations since `v0.8.0`. Startup still applies any pending
  migrations automatically.
- Image: `ghcr.io/selmant/foreseerr:v0.8.1` (also published to Docker Hub as
  `selmantr/foreseerr:v0.8.1`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` /
  `appVersion` `0.8.1` / `v0.8.1`).

## Compatibility

- No public API removals are included. Job queueing is internal scheduler
  behavior.
- Downgrades are not supported.
- Supported runtimes are Bun `>=1.4.0`, bundled SQLite, and PostgreSQL 16.
