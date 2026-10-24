# Rust backend audit — 2026-10-13

The standalone backend has no Node/Bun runtime dependency. Its production
container now uses Rust by default and packages the frontend and Swagger
browser assets without `node_modules`. The repository still has legacy
Node/Bun development commands, release archives, and comparison tooling;
the repository-wide migration is not finished.

## Fixed findings

| Finding | Before | Fix and regression coverage |
| --- | --- | --- |
| Authentication could fail open after a settings-file failure | Removing `settings.json` while running replaced the current settings with defaults, including an empty API key. A request with an empty key and an unsigned `connect.sid` cookie passed the validator and authenticated as user 1. Reproduced over HTTP. | Keep the last valid document after a missing, malformed, or non-object file. Refuse empty API keys and cookie-signing secrets. Unit tests and HTTP regressions on SQLite and Postgres cover the missing-file attack and corrupt documents. |
| Password-reset links could be consumed concurrently | Six simultaneous requests with different passwords all returned 200 for the same recovery link. A reset also could overwrite a replacement link or finish after its expiry during password hashing. | Atomically check the user, GUID, and expiry in the password update; clear both recovery fields; require one affected row. The same six-request HTTP test now has exactly one success on both databases. Unit tests cover replaced and expired links. |
| Unreadable settings could trigger an attempted replacement | Startup discarded every settings read error with `.ok()` and tried to write fresh defaults. This could replace an unreadable file when the directory permitted rename, or leave a temporary default file after another read error. | Only `NotFound` creates fresh settings. Other read errors stop startup. A filesystem regression verifies that an unreadable path does not produce a replacement file. |
| The schema guard ran after migration work | A database containing an unknown future migration could receive pending migrations or development-mode synchronization before startup refused it. | Check compatibility before migration/synchronization and again afterward. HTTP startup regressions on both databases leave a pending known migration and an unknown future migration, then verify the migration table is unchanged after the refused start. |
| Empty Node URL broke standalone startup | An empty/whitespace `FORESEERR_NODE_URL` selected standalone mode, but constructing the unused Node proxy rejected the empty URL. An invalid URL also prevented forced standalone startup. | Ignore unused Node URLs in standalone; normalize hybrid URLs and keep its default. Unit tests and isolated process starts exercise both standalone cases. |
| `DB_USE_SSL=false` did not disable Postgres TLS | SQLx's default `Prefer` mode remained active when TLS was unset or false, unlike the legacy datasource configuration. | Set `Disable` explicitly unless TLS is enabled. Preserve certificate and hostname verification by default when enabled. Unit tests cover the mode combinations; Postgres smoke/regression runs use explicit TLS-off configuration. |
| An empty optional API user header changed identity | Node ignores an empty `X-API-User` header and uses user 1. Rust interpreted it as user 0 and rejected a valid API key. | Apply the header's truthiness check before parsing. Both database regression suites exercise an empty header with a valid key. |
| Production packaging still selected Bun and runtime npm assets | The default `Dockerfile` launched `bun dist/launcher.js`. Rust's API docs resolved Swagger files through `node_modules`. | The default image runs the Rust binary. Vite emits the Swagger assets into `dist/public/api-docs`, which Rust serves directly. Isolated app roots contain only the spec and built frontend. |
| Local build/runtime files entered the Docker context | A local build sent about 4 GB, including the shadow tool's Cargo output. The Rust image copied the local config directory, which could include caches and runtime state. | Ignore all Cargo target directories and local config. Create an empty, writable config directory and Docker marker in the image. Keep compiler output and runtime state out of the build context. |
| Mapped provider cards renamed themselves after hover | User-reported for AniList. A card painted from its provider row showed the provider title, then switched to the TMDB details title once hover, focus, or tap loaded `/movie/:id` or `/tv/:id`. The card kept that title afterwards. Any mapped provider whose row title differs from TMDB was affected. | `TmdbTitleCard` keeps the row title for row-painted cards in every state. Details still load lazily after the hover-intent delay and still supply the overview, plus the score and year when the row lacks them. Unmapped cards keep the provider title. Frontend tests use differing provider and TMDB titles for AniList TV, AniList movie, and Trakt TV. They check that the label is unchanged after the details load and after a remount with cached details, and they cover an unmapped AniList card. Without the fix, four of these tests fail. |

The invalid/reset-link error remains the existing 500 response to preserve
the API contract. Password reset now deliberately improves on the legacy
backend's concurrency behavior.

## Mapped provider titles: design note

TMDB enrichment does not change a provider row's title, in either Rust's
`with_tmdb_poster` or Node's `withTmdbPoster`. The frontend change keeps
that title on row-painted cards. Backend comparisons cannot catch this
kind of inconsistency: both backends agree, and the change happened only
in the browser.

Showing localized TMDB titles on mapped cards instead would be a backend
change, applied to both backends: add the TMDB title to the row enrichment
and keep the provider title in a separate field. The card would then
render the enriched field on first paint.

Rows without a TMDB poster still render a placeholder until the details
load, then show the TMDB title. Their label does not change after it first
appears.

The tests render statically and simulate the opened card through an SWR
middleware; the repository has no DOM test environment. Live hover/close
behavior was not checked in a browser against live AniList or other
provider data. That visual check remains open.

## Verification

- Rust formatting and Clippy across all targets, with warnings denied.
- 569 passing Rust tests, including mapping-layer tests against real data.
  The two normally ignored validator differential tests were run separately.
- Fresh SQLite startup, all 83 migrations, authenticated reads, and restart.
- Fresh Postgres 18 startup, all 48 migrations, authenticated reads, and restart.
- Additional Postgres user/settings, issue/comment, request decline/delete,
  and media delete operations against seeded rows.
- 34/34 existing Node/Rust HTTP and failure/concurrency comparison scenarios.
- A 32,271-request validator corpus: all 30,756 certain cases and all 578
  representable uncertain cases matched Node. The harness reports existing
  intended differences for extreme JSON numbers, Unicode handling,
  absolute-form targets, and parser error wording; two cases cannot form an
  `http::Uri`.
- Both mapping datasets downloaded and loaded: 261,535 Anibridge edges and
  142,348 Fribb edges. The mapping tests used this database rather than
  skipping for a missing fixture.
- Regeneration of API route, migration, and development schema snapshots
  produced no drift.
- Frontend production build, Vite lint, and client typecheck. After the
  title-card fix: client typecheck, ESLint, Prettier, and all 56 frontend
  unit tests.
- New standalone regressions run against SQLite and Postgres. They serve
  exact packaged frontend/Swagger bytes from an app root without
  `node_modules`, exercise the auth failures and concurrent password resets,
  and check startup configuration and future-schema refusal.
- The default Dockerfile built successfully. Its image starts as the
  non-root `foreseerr` user, creates a fresh database, and serves the status,
  public settings, frontend, and API-doc HTML/JavaScript/CSS over HTTP.
  Image checks confirm that neither Node nor Bun nor `node_modules` is
  present, and that its initially empty config directory is writable.

The new regressions are wired into the Rust backend workflow. Run them with:

```sh
bun run build:web
cd backend-rs
cargo build --locked
python3 scripts/ci-standalone.py --bin target/debug/foreseerr --require-web
```

For Postgres, supply `DB_TYPE=postgres` and `DB_*` pointing to a dedicated
test database. The regression script changes migration records temporarily;
it must never be run against a real installation.

## Remaining migration work

| Area | Current dependency / next step |
| --- | --- |
| Default package commands | `dev`, `dev:server`, `build:server`, `build`, and `start` still target the legacy server. Use `dev:rust`, `build:rust`, and `start:rust` for standalone Rust. Switching the old commands also requires updating their callers in release and Cypress workflows. |
| Development Compose | `Dockerfile.local` and the Compose files still launch Bun development. They need a Rust toolchain and updated development commands. |
| Release server archive | `scripts/pack-server.mjs` still packs `dist/launcher.js`, `package.json`, and `bun.lock`; `.github/workflows/release.yml` publishes that archive. Replace it with platform-specific Rust binaries and browser/spec assets. |
| Compiled releases and Jellyfin sidecar | `scripts/compile.mjs` compiles `server/standalone.ts` into Bun executables, including the plugin path. Port the build/proof/package workflow and validate native Linux x64/ARM64 and Windows artifacts. The Rust managed-runtime handlers already exist, but that does not change the published executable. |
| Desktop bundle | The supervisor/bundle is maintained outside this checkout. Confirm that it launches the Rust child and ships the spec/frontend, then test readiness, session restore, shutdown, and upgrades there. |
| TypeScript server sources | The generators and differential tests use the legacy server as their reference. The frontend also imports shared interfaces/enums/utilities from `server/`. Move shared definitions before deleting backend-only TypeScript or npm dependencies. |
| Frontend build tooling | Bun/Vite/React remain build/browser dependencies. No JavaScript server process is needed by the Rust production container. |

No deployment or published release was changed by this audit. Local
test processes use private config directories and a disposable Postgres
container. Changes are in the working tree.

This review does not establish exhaustive correctness of every integration.
Live Plex, Jellyfin, Arr, OAuth, SMTP, notification delivery, and external
desktop/plugin launchers need end-to-end checks in their own environments.
The remaining `Outcome::Forward` paths are compatibility/error decisions:
standalone returns their local fallback responses, which may still differ
from Node for unusual inputs or upstream failures.
