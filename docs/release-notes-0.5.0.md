---
title: Foreseerr v0.5.0 release notes
---

## Highlights

- Adds a full Library Browse experience for owned Jellyfin media: search,
  filters, infinite scroll, and URL-backed query state.
- Splits Library into Overview (continue watching / recently added) and Browse
  (searchable grid), with cinematic overview cards and leaner browse posters.
- Adds an adaptive item inspector with proxied Jellyfin artwork, season and
  episode lists, play/resume, and rating controls.
- Shows unplayed markers, remaining-episode counts on series posters, and more
  scannable watch state on library cards.

## Fixes

- Persists the Jellyfin session on password login so Watch Now and related
  library calls keep working after sign-in.
- Aligns Discover and Library genre filters so mixed movie/TV lists match
  equivalent TMDB genres (for example Fantasy with Sci-Fi & Fantasy).
- Hides empty series and non-playable Play buttons in Library.
- Bounds release-artifact signature verification time.

## Upgrade notes

- Upgrades from Foreseerr `v0.1.0`, `v0.2.0`, `v0.2.1`, `v0.3.0`, and `v0.4.x`
  are supported. Back up your configuration before upgrading.
- No new database migrations are included in this release.
- Image: `ghcr.io/selmant/foreseerr:v0.5.0` (also published to Docker Hub as
  `selmantr/foreseerr:v0.5.0`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` /
  `appVersion` `0.5.0` / `v0.5.0`).

## Compatibility

- No public API removals are included. Library browse, facets, inspector, and
  image-proxy endpoints are additive.
- Downgrades are not supported.
- Supported runtimes remain Node.js `^22.19.0 || ^24.0.0`, pnpm `^10.0.0`,
  bundled SQLite, and PostgreSQL 16.
