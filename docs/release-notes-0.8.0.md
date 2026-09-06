---
title: Foreseerr v0.8.0 release notes
---

## Highlights

- Runs on Bun (`>=1.4.0`) instead of Node.js + pnpm. Docker images already
  ship the runtime; from-source installs must use Bun.
- Attaches packed standalone SQLite server binaries to GitHub Releases
  (`linux-x64`, `linux-arm64`, `windows-x64`) with `SHA256SUMS`.
- Proxies AniList, Simkl, and TVDB artwork through the image cache and expires
  idle cached images (default 7 days). Configure under Settings → General and
  Jobs & Cache.
- Lazy-loads Discover rows so the homepage does not fetch every slider at once.

## Fixes

- Stops the search box from bouncing between the last two queries.
- Shows `Foreseerr` in the browser tab before settings load, instead of the URL.
- Drops a no-op Discover slider-type “repair” that never remapped rows.

## Upgrade notes

- Upgrades from Foreseerr `v0.1.0`, `v0.2.0`, `v0.2.1`, `v0.3.0`, `v0.4.x`,
  `v0.5.x`, `v0.6.x`, and `v0.7.x` are supported. Back up your configuration
  before upgrading.
- From-source installs: Bun `>=1.4.0` (`bun install --frozen-lockfile`,
  `bun run build`, `bun run start`). Node.js + pnpm is no longer supported.
- No new database migrations since `v0.7.1`. Startup still applies any pending
  migrations automatically.
- Image: `ghcr.io/selmant/foreseerr:v0.8.0` (also published to Docker Hub as
  `selmantr/foreseerr:v0.8.0`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` /
  `appVersion` `0.8.0` / `v0.8.0`).

## Compatibility

- No public API removals are included. Image-proxy sources and cache idle
  expiry are additive.
- Downgrades are not supported.
- Supported runtimes are Bun `>=1.4.0`, bundled SQLite, and PostgreSQL 16.
