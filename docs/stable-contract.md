---
title: Stable contract (Phase 0 decisions)
---

:::info Status
This is a maintainer-facing reference, not published end-user documentation. It records the Phase 0 ("Freeze the Stable Contract") decisions from the Foreseerr stabilization plan so later phases have a fixed target instead of re-deciding these questions per PR. Fold the relevant parts into real user-facing docs (API docs, [migration guide](/migration-guide), [backups](/using-seerr/backups)) as they stabilize; this file itself can be retired once its content is fully absorbed there.
:::

## Supported upgrade sources

At the first stable release, Foreseerr supports upgrading in place from:

1. **A fresh Foreseerr installation.** No prior data; migrations run from an empty database.
2. **An upstream Seerr database (SQLite or PostgreSQL)**, validated against the synced Seerr commit `bd491c7e7ecf7d249da532f8fe9b82456ed6e42e`. Foreseerr's migration history continues directly from this commit's schema.
3. **A previous stable Foreseerr release**, starting with `v0.1.0`, including the releases that still ran the Node backend: the Rust backend runs the same migrations on the same schema and records them in the same `migrations` table.

The migrations live in `backend-rs/src/dbmigrate/` (`sqlite.rs`, `postgres.rs`), in the order they run. Automated coverage:

- The `migration-test` job in `.github/workflows/ci.yml` — fresh install on both engines (`backend-rs/scripts/ci-smoke.py`): every migration applies in order, the server starts and answers, and a restart applies nothing new.
- `cargo test` in `backend-rs/` (`src/dbmigrate/tests.rs`) — the fresh SQLite schema matches the recorded reference, the schema guard, and the data backfills.

Alpha builds (`0.1.0-alpha.x`) are explicitly **not** part of the supported-upgrade guarantee above; see [Backups → Upgrading and downgrading](/using-seerr/backups) and [`docs/release-notes-0.1.0.md`](/release-notes-0.1.0).

## When re-syncing upstream Seerr

User-facing migration docs are evergreen: they describe “same config volume / startup migrations,” not a Seerr-version matrix. Do **not** rewrite [migration-guide](/migration-guide) for routine Seerr releases. Only edit that guide when the procedure itself changes (config paths, image name, safety rules).

When pulling a newer Seerr merge-base into this fork:

1. Port the new upstream TypeORM migrations to `backend-rs/src/dbmigrate/{sqlite,postgres}.rs` with their original names and timestamps, so a database upgraded by Seerr records the same rows Foreseerr expects.
2. Update the baseline commit above to the synced Seerr commit.
3. Upgrade a copy of a Seerr database (SQLite and PostgreSQL) from that commit and confirm users/settings/requests/media/service config survive; keep CI green before shipping the sync.
4. Leave the user migration guide unchanged unless the operational steps above actually changed.

Seerr instances newer than the published baseline remain unsupported until the next sync that advances that baseline.

## Pagination contract

Decision: **cursor/page plus `hasMore`**, not exact totals produced by a complete scan.

- Endpoints that can compute an exact total cheaply from the upstream provider (e.g. Plex-backed watchlist) may still report `totalPages`/`totalResults`, but these are always optional.
- Endpoints that filter, merge, or paginate across upstream sources (Trakt mixed-media `all`, TMDB discover with client-side filters applied) MUST NOT report a total; they report `page` and `hasMore` only. See `WatchlistResponse` in `shared/interfaces/api/discoverInterfaces.ts` and the paging in `backend-rs/src/traktitems.rs`.
- A requested page must never return more than the requested page size, even for merged/deduplicated `all`-media results (`backend-rs/src/traktitems.rs`, `backend-rs/src/routes/discover.rs`, `backend-rs/src/routes/traktpages.rs`).
- Working rule (from the stabilization plan): never report exact pagination totals when only an estimate or `hasMore` is known.

## Media-type semantics

Decision: **anime is a subtype presented through an explicit fourth domain value**, not a separate top-level content type disconnected from movie/TV.

- The stable domain union is `'movie' | 'tv' | 'anime' | 'all'` (see `backend-rs/src/routes/trakt.rs`). The legacy overloaded `'both'` value has been removed from the backend contract.
- `'all'` includes anime — it is not "everything except anime." Anime movies/shows are still tagged as anime (via TMDB keyword detection, see `backend-rs/src/routes/traktpages.rs`) so callers can filter them in or out explicitly.
- This applies consistently across Trakt recommendations, watchlist, history, and custom/public lists.

## Settings migrators

- `settings.json` has an implicit schema version: the ordered list of migration names in `backend-rs/src/standalone/settingsmigrations.rs` (`NAMES`, `000N_description`), each a single transform.
- After the first stable release, migrations are append-only and forward-only: a shipped migration is never edited or removed; a structural change ships as a new migration file.
- The migrator (same file) records which migrations have been applied inside `settings.json` itself, backs up the pre-migration file to `settings.old.json`, and — critically — refuses to start if the file already records a migration this build doesn't recognize, rather than silently running against a newer schema it doesn't understand. The equivalent guard for the database schema is `assert_supported_schema` in `backend-rs/src/dbmigrate/mod.rs`.
- Downgrading is never supported for settings or the database; the actionable recovery path is always "restore the backup taken before the upgrade" (see [Backups](/using-seerr/backups)).

## Working rules this contract enforces

These map 1:1 to the stabilization plan's working rules and are the reason the decisions above are fixed instead of re-litigated per PR:

- Prefer explicit `all`, `movie`, `tv`, `anime` over overloaded names such as `both`.
- Do not edit a migration (database or settings) after it has shipped in a stable release; append a new one instead.
- Never report exact pagination totals when only an estimate or `hasMore` is known.
- Treat external-provider write failures as failures, not successful empty states (see `backend-rs/src/mediaactions/`).
