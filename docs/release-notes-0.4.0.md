---
title: Foreseerr v0.4.0 release notes
---

## Highlights

- Adds a personal release calendar with notifications, filtering, and a full-day view for scheduled releases.
- Adds a Library experience for owned Jellyfin media, including recently added, series detail panels, next-up/resume actions, and watch-state controls.
- Extends the native Foreseer Desktop integration with challenge-bound, short-lived authentication tickets and reliable playback return handling.
- Adds a native-only Quit control and improves discovery-to-playback routing for the desktop shell.

## Upgrade notes

- Upgrades from Foreseerr `v0.1.0`, `v0.2.0`, `v0.2.1`, and `v0.3.0` are supported. Back up your configuration before upgrading.
- New SQLite and PostgreSQL migrations create the release-calendar, desktop-auth-ticket, and release-sync data. They run automatically at startup.
- Image: `ghcr.io/selmant/foreseerr:v0.4.0` (also published to Docker Hub as `selmantr/foreseerr:v0.4.0`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` / `appVersion` `0.4.0` / `v0.4.0`).

## Compatibility

- No public API removals are included. The Library, Calendar, and native-runtime APIs are additive.
- Downgrades are not supported after the new database migrations have run.
- Supported runtimes remain Node.js `^22.19.0 || ^24.0.0`, pnpm `^10.0.0`, bundled SQLite, and PostgreSQL 16.
