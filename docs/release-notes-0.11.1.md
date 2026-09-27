---
title: Foreseerr v0.11.1 release notes
---

## Changes

- Mapping packs are now opt-in. A new install downloads none until an admin
  enables them on **Settings → Mapping**, and page loads no longer start a
  pack refresh; installed packs still refresh on the nightly **Mapping Pack
  Refresh** job and the page's **Refresh** button. The packs match anime to
  TMDB, so the Mapping and AniList settings warn while none is installed.

## Fixes

- Installing or refreshing a mapping pack no longer makes Foreseerr stop
  answering for minutes, which showed up as 504 Gateway Timeout inside
  Jellyfin. The pack is written in short slices, and lookups use the
  downloaded pack while the graph catches up. A rewrite cut short by an error
  or restart is redone on the next refresh.
- The calendar's **Discover titles** button opened the 404 page; it now opens
  Discover. When no Sonarr or Radarr server is connected, the empty calendar
  says so, and admins get a link to the integrations settings.

## Upgrade notes

- Upgrades from Foreseerr `v0.1.0`, `v0.2.0`, `v0.2.1`, `v0.3.0`, `v0.4.x`,
  `v0.5.x`, `v0.6.x`, `v0.7.x`, `v0.8.x`, `v0.9.x`, `v0.10.x`, and `v0.11.0`
  are supported. Back up your configuration before upgrading.
- No new database migrations since `v0.11.0`. Packs that are already
  installed stay enabled.
- Image: `ghcr.io/selmant/foreseerr:v0.11.1` (also published to Docker Hub as
  `selmantr/foreseerr:v0.11.1`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` /
  `appVersion` `0.11.1` / `v0.11.1`).

## Compatibility

- No public API removals are included.
- Downgrades are not supported.
- Supported runtimes are Bun `>=1.4.0`, bundled SQLite, and PostgreSQL 16.
