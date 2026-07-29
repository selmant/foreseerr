---
title: Foreseerr v0.2.0 release notes
---

## Highlights

- Request individual TV episodes using TVDB episode data, including range selection and ongoing episode requests.
- See episode-level request status and watched state directly in season and episode views.
- Mark individual episodes watched or unwatched through Trakt, with watch progress refreshed before the action is shown.
- Improved Sonarr synchronization after episode requests and clearer season-request state in the episode selector.
- Fixed poster titles being clipped when rating badges expand on hover.

## Upgrade notes

- Upgrades from Foreseerr `v0.1.0` are supported. Back up your configuration before upgrading.
- This release adds episode-request database migrations for SQLite and PostgreSQL. They run automatically at startup.
- Image: `ghcr.io/selmant/foreseerr:v0.2.0` (also published to Docker Hub as `selmantr/foreseerr:v0.2.0`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` / `appVersion` `0.2.0` / `v0.2.0`).
- Alpha builds (`0.1.0-alpha.x`) remain unsupported upgrade sources; migrate from Seerr or start with a fresh Foreseerr installation.

## Compatibility

- No public API removals are included in this release.
- Downgrades are not supported after the new database migration has run.
- Supported runtimes remain Node.js `^22.19.0 || ^24.0.0`, pnpm `^10.0.0`, bundled SQLite, and PostgreSQL 16.
