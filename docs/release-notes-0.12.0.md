---
title: Foreseerr v0.12.0 release notes
---

## Changes

- `GET /api/v1/settings/discover` now says where each slider loads from, so
  clients such as Moonfin can show Foreseerr's Trakt, AniList, Simkl, and
  MDBList rows without knowing its slider types. Each slider carries
  `endpoint`, the API path and query for one page of its results, and the
  built-in Trakt, AniList, and Simkl rows carry `defaultTitle`, their English
  name. Both are computed per response and never stored.
- Trakt, AniList, Simkl, MDBList, and Plex watchlist tiles now carry
  `backdropPath`, `releaseDate` or `firstAirDate`, and `mediaInfo` (`status`
  and `status4k`), the fields Seerr discover results have. They come from
  data Foreseerr already fetched, so pages make no extra requests.

## Fixes

- An AniList tile whose TMDB match was repaired now opens the repaired
  title. Its `id` kept the old, dead TMDB id before.
- With **Hide unmapped titles** on, tiles that have no movie or series type,
  such as some entries in unified MDBList lists, are hidden too. They could
  not be opened.
- The Simkl trending and library routes accept `hideUnmapped`. The API
  rejected it as an unknown parameter before.

## Upgrade notes

- Upgrades from Foreseerr `v0.1.0`, `v0.2.0`, `v0.2.1`, `v0.3.0`, `v0.4.x`,
  `v0.5.x`, `v0.6.x`, `v0.7.x`, `v0.8.x`, `v0.9.x`, `v0.10.x`, and `v0.11.x`
  are supported. Back up your configuration before upgrading.
- No new database migrations since `v0.11.1`.
- Image: `ghcr.io/selmant/foreseerr:v0.12.0` (also published to Docker Hub as
  `selmantr/foreseerr:v0.12.0`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` /
  `appVersion` `0.12.0` / `v0.12.0`).

## Compatibility

- No public API removals are included. The new slider and tile fields are
  additions.
- Downgrades are not supported.
- Supported runtimes are Bun `>=1.4.0`, bundled SQLite, and PostgreSQL 16.
