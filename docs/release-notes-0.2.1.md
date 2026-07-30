---
title: Foreseerr v0.2.1 release notes
---

## Fixes

- Seasons with only some episodes requested or available can now be selected for a full-season request.
- Full-season requests following episode requests are accepted by the API instead of being rejected as duplicates.
- Fully available seasons and seasons with an active full-season request remain protected from duplicate requests.

## Upgrade notes

- Upgrades from Foreseerr `v0.1.0` and `v0.2.0` are supported. Back up your configuration before upgrading.
- This patch release contains no database migrations or public API removals.
- Image: `ghcr.io/selmant/foreseerr:v0.2.1` (also published to Docker Hub as `selmantr/foreseerr:v0.2.1`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` / `appVersion` `0.2.1` / `v0.2.1`).

## Compatibility

- Supported runtimes remain Node.js `^22.19.0 || ^24.0.0`, pnpm `^10.0.0`, bundled SQLite, and PostgreSQL 16.
