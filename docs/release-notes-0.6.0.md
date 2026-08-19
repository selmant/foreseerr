---
title: Foreseerr v0.6.0 release notes
---

## Highlights

- Adds AniList Discover for anime: public catalog rows (trending, this season,
  popular, top 100, next season) work with app credentials only. Linked
  accounts get watching / planning / completed rows, named personal lists,
  and optional watched/score sync. Titles are mapped to TMDB; unmapped anime
  are omitted.
- Lets admins pin public MDBList lists as custom Discover sliders (search or
  paste a URL / `user/slug` / numeric id). Uses the same API key and daily
  quota as rating badges. Personalized MDBList recs and “My Lists” are not
  included.
- Marks Trakt, AniList, and MDBList Discover rows with source logos so custom
  list titles show which service they come from.
- Documents Discover sources and Integrations setup (Trakt, AniList, MDBList).

## Fixes

- Pings AniList GraphQL with a media field so a valid Client ID/secret is not
  marked degraded after save.
- Caps Library scanner concurrency so unbounded scan bundles cannot exhaust
  the default Postgres pool and leave idle-in-transaction sessions.

## Upgrade notes

- Upgrades from Foreseerr `v0.1.0`, `v0.2.0`, `v0.2.1`, `v0.3.0`, `v0.4.x`,
  and `v0.5.x` are supported. Back up your configuration before upgrading.
- No new database migrations are included in this release.
- Image: `ghcr.io/selmant/foreseerr:v0.6.0` (also published to Docker Hub as
  `selmantr/foreseerr:v0.6.0`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` /
  `appVersion` `0.6.0` / `v0.6.0`).

## Compatibility

- No public API removals are included. AniList catalog/list discover endpoints
  and MDBList list search/items endpoints are additive.
- Downgrades are not supported.
- Supported runtimes remain Node.js `^22.19.0 || ^24.0.0`, pnpm `^10.0.0`,
  bundled SQLite, and PostgreSQL 16.
