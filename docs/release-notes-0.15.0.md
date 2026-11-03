---
title: Foreseerr v0.15.0 release notes
---

## A Rust backend

- Foreseerr's server is now one Rust binary. The Node/TypeScript server, its
  Bun-compiled builds and the Cypress suite are gone. The new backend runs the
  same database migrations, reads and writes the same `settings.json`, runs
  the same jobs and answers the same API, so an existing install upgrades in
  place.
- The Docker image is Alpine with the binary and the built web app: no Bun,
  no Node and no `node_modules`. It still runs as UID/GID `1000` and keeps its
  data in `/app/config`, so existing volumes need no permission changes.
- Releases attach ready-to-run server archives,
  `foreseerr-{linux-x64,linux-arm64}.tar.gz` and `foreseerr-windows-x64.zip`,
  plus `foreseerr-plugin-*` builds for the Jellyfin plugin and a `SHA256SUMS`
  file. The Linux builds run on glibc 2.28 or newer. They replace the
  `foreseerr-server` archive.
- SQLite no longer reports "database is locked" while the anime mapping
  datasets import on the first start, which used to break the Jellyfin
  plugin's sign-in.

## Sonarr 5

- Sonarr 5, which drops the v3 API, is supported through its v5 API. Foreseerr
  detects which API each Sonarr server speaks; Sonarr 4 is unchanged.
- Series in another episode order than the aired one (DVD, absolute, story,
  streaming) are monitored and counted by matching episodes on their TVDB id,
  so a request for aired season 2 no longer monitors the order's season 2.
  An episode missing from the series' order is marked failed instead of being
  retried. The Manage panel warns when a series isn't in aired order.
- Sonarr 5 requires a metadata language when adding a series. It is set in the
  Sonarr server settings, with an anime override, and per request in the
  advanced options.
- A show TMDB has no TVDB id for is looked up in Sonarr by its TMDB id before
  the request is dropped (Sonarr 4 too). Anime can be mapped through Sonarr's
  AniList/MyAnimeList ids.
- Interactive search explains Sonarr 5's rejection reasons in plain language,
  shows grabbed and failed history per release, and warns that Sonarr 5 won't
  import multi-season packs on its own.
- A download covering several episodes shows as one entry ("S02 pack
  (10 eps)") in its badge and in the Manage panel.
- With requester tags on, a user's profile shows how much Sonarr 5 storage
  their series use.

## Manual import

- Opened from an intervention, Manual Import goes straight to that
  intervention's download and its files, with the ready ones already
  selected: two clicks for a typical import.
- Picking episodes rematches the file with the service automatically. Files of
  a season pack can be numbered in name order in one step, and shift-click
  selects a range of episodes.
- Quality and language can be set where the service left them missing or
  Unknown.
- After submitting, the panel follows the import until it finishes, and a
  failure offers to review the files again.
- Files the service flags as dangerous or executable can't be imported, and
  files from a multi-season download need their episodes picked first.

## Fixes

- Rejecting a stuck Sonarr 5 download that Sonarr can't blocklist now also
  removes it from Sonarr's queue.
- A manual-import file rematched on Sonarr 4 can be imported again.
- A forced grab of a multi-season pack is recorded against every episode the
  release covers, not only the searched season.

## Upgrade notes

- Upgrades from earlier stable Foreseerr releases, including `v0.14.1`, are
  supported on SQLite and PostgreSQL. Back up your configuration and database
  before upgrading.
- One new database migration, `AddRequestMetadataLanguage`, adds the request's
  metadata language.
- Environment variables keep their names, including `NODE_ENV=production`
  (which turns on the migrations and serving the web app) and
  `NODE_EXTRA_CA_CERTS`. `DB_LOG_QUERIES` is no longer read; set
  `RUST_LOG=info,sqlx::query=debug` to log SQL statements.
- Building from source needs Rust (through `rustup`) as well as Bun, which
  still builds the web app. `bun run build` builds both, and `bun run start`
  starts the binary.
- Image: `ghcr.io/selmant/foreseerr:v0.15.0` (also published to Docker Hub as
  `selmantr/foreseerr:v0.15.0`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` /
  `appVersion` `0.15.0` / `v0.15.0`).
- The Jellyfin plugin and Foreseer Desktop bundle their own Foreseerr version.
  They move to this backend in their next releases.

## Compatibility

- **Breaking:** the `foreseerr-server` release archive and the Bun runtime are
  gone; use the image or the new server archives.
- New endpoints: `GET /api/v1/user/{userId}/sonarr-storage` and
  `GET /api/v1/media/{id}/servarr/imports/options`. The manual import
  endpoints accept `interventionId` and `overrides`; the other new response
  fields are optional.
- Error message texts can differ from earlier releases; statuses don't.
- Downgrades are not supported.
- Supported runtimes are the published image and server archives, bundled
  SQLite, and PostgreSQL 16 or newer.
