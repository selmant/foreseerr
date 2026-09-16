---
title: Foreseerr v0.9.0 release notes
---

## Fixes

- Treats AniList downtime (HTTP 403) as a temporary outage instead of prompting
  users to reconnect. Public Discover AniList rows also authenticate with a
  linked account when anonymous GraphQL is rejected.
- Remaps Foreseer Discover slider type ids to start at `1001`, leaving room for
  upstream Overseerr types in the `22+` range (database migration).
- Always rebuilds the SPA when packing standalone binaries so releases do not
  ship a stale `dist/public`.
- Sends Jellyfin `Authorization` on logout and avatar requests so Jellyfin 12
  does not 401 leftover device-delete / avatar-proxy calls.

## Upgrade notes

- Upgrades from Foreseerr `v0.1.0`, `v0.2.0`, `v0.2.1`, `v0.3.0`, `v0.4.x`,
  `v0.5.x`, `v0.6.x`, `v0.7.x`, and `v0.8.x` are supported. Back up your
  configuration before upgrading.
- Includes a Discover slider type remapping migration
  (`RemapDiscoverSliderTypes`). Startup applies pending migrations
  automatically.
- Image: `ghcr.io/selmant/foreseerr:v0.9.0` (also published to Docker Hub as
  `selmantr/foreseerr:v0.9.0`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` /
  `appVersion` `0.9.0` / `v0.9.0`).

## Compatibility

- No public API removals are included. Slider type remapping is internal to
  persisted Discover rows.
- Downgrades are not supported.
- Supported runtimes are Bun `>=1.4.0`, bundled SQLite, and PostgreSQL 16.
