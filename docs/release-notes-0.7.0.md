---
title: Foreseerr v0.7.0 release notes
---

## Highlights

- Adds Simkl as a Discover and library-sync source: PIN-linked accounts, Trending /
  Best / Premieres rows, and watched/rating actions. Titles resolve to TMDB
  through the mapping layer.
- Resolves AniList, Simkl, Trakt, TVDB, IMDb, and related ids through a
  persistent mapping graph. Packs refresh daily, live providers fill gaps, and
  **Settings → Mapping** shows health, pack progress, and repair for unmapped
  titles. See [Mapping packs](./using-seerr/advanced/mapping-packs.md).
- Adds a Servarr intervention inbox and release blocklist so failed or
  blocked Radarr/Sonarr imports can be reviewed in-app.
- Auto-completes skipped episode endings with a configurable leftover
  threshold, so a show does not stay in Resume for a handful of unwatched
  leftovers.
- Hardens the optional native Desktop companion: standalone bundled server,
  playback-aware job scheduling, LAN Jellyfin with external fallback, recovery
  actions, and cache budget controls. Pair with Foreseer Desktop `0.3.0`.

## Fixes

- Maps anime films and franchise clusters that previously stayed unmapped or
  landed on the wrong TMDB hub.
- Omits Simkl video-game / YouTube play titles from Discover and drops
  colliding TMDB ids that belong to a different title.
- Restores Library unwatched markers (corner pip and New ribbon) after poster
  overflow and ribbon-size regressions.
- Keeps the desktop managed server URL, login session, and catch-up jobs
  correct across playback, restart, and standalone recovery.

## Upgrade notes

- Upgrades from Foreseerr `v0.1.0`, `v0.2.0`, `v0.2.1`, `v0.3.0`, `v0.4.x`,
  `v0.5.x`, and `v0.6.x` are supported. Back up your configuration before
  upgrading.
- Database migrations add skipped-episode settings, Servarr interventions,
  Simkl user/cache tables, and the mapping graph (including provenance).
  Startup applies them automatically.
- Image: `ghcr.io/selmant/foreseerr:v0.7.0` (also published to Docker Hub as
  `selmantr/foreseerr:v0.7.0`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` /
  `appVersion` `0.7.0` / `v0.7.0`).
- Native companion: [Foreseer Desktop `0.3.0`](https://github.com/selmant/foreseerr-desktop/releases).

## Compatibility

- No public API removals are included. Simkl, mapping, Servarr intervention,
  and standalone-desktop endpoints are additive.
- Downgrades are not supported.
- Supported runtimes remain Node.js `^22.19.0 || ^24.0.0`, pnpm `^10.0.0`,
  bundled SQLite, and PostgreSQL 16.
