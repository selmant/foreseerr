---
title: Stable contract (Phase 0 decisions)
---

:::info Status
This is a maintainer-facing reference, not published end-user documentation. It records the Phase 0 ("Freeze the Stable Contract") decisions from the Foreseer stabilization plan so later phases have a fixed target instead of re-deciding these questions per PR. Fold the relevant parts into real user-facing docs (API docs, [migration guide](/migration-guide), [backups](/using-seerr/backups)) as they stabilize; this file itself can be retired once its content is fully absorbed there.
:::

## Supported upgrade sources

At the first stable release, Foreseer supports upgrading in place from:

1. **A fresh Foreseer installation.** No prior data; migrations run from an empty database.
2. **An upstream Seerr database (SQLite or PostgreSQL)**, validated against the Seerr merge-base commit `759e35933860594282bd929587576b003a3efb2d`. Foreseer's migration history continues directly from this commit's schema.
3. **A previous stable Foreseer release**, once one exists. No stable release has shipped yet, so this source has no fixture/upgrade test yet — see the note in [`docs/release-notes-draft.md`](/release-notes-draft).

Automated coverage:

- `pnpm check:migrations` — fresh-install matrix for both engines (`server/migration/*` + `scripts/check-migrations.ts`), asserting key indexes/foreign keys exist, not just that the migration runner exits 0.
- `server/migration/upgradeMatrix.sqlite.test.ts` / `.postgres.test.ts` — upgrade-from-baseline matrix, asserting users/settings/requests/media/service config survive the upgrade, not just that migrations run.

Alpha builds are explicitly **not** part of the supported-upgrade guarantee above; see the alpha-to-stable policy in [`docs/release-notes-draft.md`](/release-notes-draft) and the warning in [Backups → Upgrading and downgrading](/using-seerr/backups).

## Pagination contract

Decision: **cursor/page plus `hasMore`**, not exact totals produced by a complete scan.

- Endpoints that can compute an exact total cheaply from the upstream provider (e.g. Plex-backed watchlist) may still report `totalPages`/`totalResults`, but these are always optional.
- Endpoints that filter, merge, or paginate across upstream sources (Trakt mixed-media `all`, TMDB discover with client-side filters applied) MUST NOT report a total; they report `page` and `hasMore` only. See `WatchlistResponse` in `server/interfaces/api/discoverInterfaces.ts` and `TraktPaginatedItems` in `server/lib/trakt/mixedPagination.ts`.
- A requested page must never return more than the requested page size, even for merged/deduplicated `all`-media results (`server/lib/trakt/mixedPagination.ts`, `server/lib/discover/filteredPagination.ts`, `server/lib/discover/traktDiscoverPagination.ts`).
- Working rule (from the stabilization plan): never report exact pagination totals when only an estimate or `hasMore` is known.

## Media-type semantics

Decision: **anime is a subtype presented through an explicit fourth domain value**, not a separate top-level content type disconnected from movie/TV.

- The stable domain union is `'movie' | 'tv' | 'anime' | 'all'` (see `TraktBrowseMediaType` in `server/api/trakt/interfaces.ts`). The legacy overloaded `'both'` value has been removed from the backend contract.
- `'all'` includes anime — it is not "everything except anime." Anime movies/shows are still tagged as anime (via TMDB keyword detection, see `server/lib/trakt/animeFilter.ts`) so callers can filter them in or out explicitly.
- This applies consistently across Trakt recommendations, watchlist, history, and custom/public lists, and across the request-routing settings that pick a Radarr/Sonarr server per domain (`server/lib/requestFilters/routing.ts`, `RequestRoutingSettings`).

## Settings migrators

- `settings.json` has an implicit schema version: the ordered list of migration filenames under `server/lib/settings/migrations/` (`000N_description.ts`), each exporting a single transform function.
- Migrations are append-only and forward-only: a shipped migration is never edited or removed; a structural change ships as a new migration file.
- The migrator (`server/lib/settings/migrator.ts`) records which migrations have been applied inside `settings.json` itself, backs up the pre-migration file to `settings.old.json`, and — critically — refuses to start (`assertNoUnsupportedMigrations`) if the file already records a migration this build doesn't recognize, rather than silently running against a newer schema it doesn't understand. The equivalent guard for the database schema is `assertSupportedDatabaseSchema` in `server/lib/db/schemaGuard.ts`.
- Downgrading is never supported for settings or the database; the actionable recovery path is always "restore the backup taken before the upgrade" (see [Backups](/using-seerr/backups)).

## Working rules this contract enforces

These map 1:1 to the stabilization plan's working rules and are the reason the decisions above are fixed instead of re-litigated per PR:

- Prefer explicit `all`, `movie`, `tv`, `anime` over overloaded names such as `both`.
- Do not edit a migration (database or settings) after it has shipped in a stable release; append a new one instead.
- Never report exact pagination totals when only an estimate or `hasMore` is known.
- Treat external-provider write failures as failures, not successful empty states (see `server/lib/mediaActions/writeOutcome.ts`).
