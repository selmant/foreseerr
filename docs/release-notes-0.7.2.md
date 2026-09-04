---
title: Foreseerr v0.7.2 release notes
---

## Fixes

- Puts TMDB `posterPath` on mapped Simkl Discover tiles so clients that draw
  the list payload (not TmdbTitleCard) show posters.

## Upgrade notes

- Upgrades from Foreseerr `v0.1.0`, `v0.2.0`, `v0.2.1`, `v0.3.0`, `v0.4.x`,
  `v0.5.x`, `v0.6.x`, `v0.7.0`, and `v0.7.1` are supported. Back up your
  configuration before upgrading.
- No database migration is included.
- Image: `ghcr.io/selmant/foreseerr:v0.7.2` (also published to Docker Hub as
  `selmantr/foreseerr:v0.7.2`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` /
  `appVersion` `0.7.2` / `v0.7.2`).

## Compatibility

- No public API removals are included. `posterPath` on mapped Simkl tiles is
  additive.
- Downgrades are not supported.
- Supported runtimes remain Node.js `^22.19.0 || ^24.0.0`, pnpm `^10.0.0`,
  bundled SQLite, and PostgreSQL 16.
