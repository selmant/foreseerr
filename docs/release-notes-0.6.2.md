---
title: Foreseerr v0.6.2 release notes
---

## Fixes

- Sends Radarr movie adds from the same Postgres transaction that creates the
  request. A second pool connection could not see the new Media row until
  commit, so approved requests stayed Pending in the UI and never reached
  Radarr.
- Marks imported movies Available from Radarr/Sonarr `hasFile` every 15
  minutes. Jellyfin recently-added previously only asked for 12 Latest items,
  and files that keep an old mtime never appeared there, so completed
  downloads stayed on Requested until the 04:00 scan.
- Treats empty Jellyfin series shells as incomplete (RecursiveItemCount) and
  uses a partial mark for remaining-episode posters.

## Features

- Shows Discover titles that have no TMDB match instead of hiding them, with
  source cards, hide / auto-hide, and an amber corner ribbon so they do not
  look like normal TMDB posters.

## Upgrade notes

- Upgrades from Foreseerr `v0.1.0`, `v0.2.0`, `v0.2.1`, `v0.3.0`, `v0.4.x`,
  `v0.5.x`, and `v0.6.0` / `v0.6.1` are supported. Back up your configuration
  before upgrading.
- No new database migrations. Settings gain migrator `0014_arr_scan_15m`,
  which rewrites the factory daily Radarr/Sonarr crons to every 15 minutes
  unless an administrator already set a custom schedule.
- Image: `ghcr.io/selmant/foreseerr:v0.6.2` (also published to Docker Hub as
  `selmantr/foreseerr:v0.6.2`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` /
  `appVersion` `0.6.2` / `v0.6.2`).

## Compatibility

- No public API removals are included.
- Downgrades are not supported.
- Supported runtimes remain Node.js `^22.19.0 || ^24.0.0`, pnpm `^10.0.0`,
  bundled SQLite, and PostgreSQL 16.
