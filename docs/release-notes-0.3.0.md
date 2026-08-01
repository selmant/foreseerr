---
title: Foreseerr v0.3.0 release notes
---

## Highlights

- Choose between Direct Trakt credentials and the Better Trakt Jellyfin bridge as the Trakt provider.
- Redesigned Trakt connection settings, with Better Trakt setup on a dedicated integrations page.
- Live integration health checks for Trakt, Better Trakt, and MDBList from settings.
- Refresh a linked Jellyfin session when Better Trakt needs an updated media-server login.
- Merged recent upstream Seerr fixes, including safer Radarr/Sonarr removals, Plex merged-version availability sync, IPv6 `HOST` support, and an option to disable the version check.

## Upgrade notes

- Upgrades from Foreseerr `v0.1.0`, `v0.2.0`, and `v0.2.1` are supported. Back up your configuration before upgrading.
- This release includes the upstream `AddIgnoreQuotaToMediaRequest` database migration for SQLite and PostgreSQL. It runs automatically at startup.
- Existing Direct Trakt setups keep working; `trakt.provider` defaults to `direct` when unset.
- Image: `ghcr.io/selmant/foreseerr:v0.3.0` (also published to Docker Hub as `selmantr/foreseerr:v0.3.0`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` / `appVersion` `0.3.0` / `v0.3.0`).
- Alpha builds (`0.1.0-alpha.x`) remain unsupported upgrade sources; migrate from Seerr or start with a fresh Foreseerr installation.

## Compatibility

- No public API removals are included in this release. Trakt settings gain an additive `provider` field (`direct` | `jellyfin`).
- Downgrades are not supported after the new database migration has run.
- Supported runtimes remain Node.js `^22.19.0 || ^24.0.0`, pnpm `^10.0.0`, bundled SQLite, and PostgreSQL 16.
