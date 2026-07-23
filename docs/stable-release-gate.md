---
title: Stable release gate (Phase 5)
---

:::info Status
This is a maintainer-facing tracking document, not published end-user documentation. It is the single checklist gating removal of the alpha label from Foreseer, per Phase 5 of the stabilization plan (`plan.md`). **Do not remove the alpha label until every item below is checked.** Automation results below were captured on 2026-07-23 against `0.1.0-alpha.5` on `develop`; re-run them before cutting the actual release, since this snapshot will go stale.
:::

## How to use this document

- The **Required automation** section is re-runnable and has already been executed once (results below). Re-run it again immediately before cutting the stable release, since `develop` will keep moving.
- The **Required manual validation** section cannot be completed by an agent — it needs a human with real Trakt/MDBList credentials and real Radarr/Sonarr/media-server instances. Every box below is intentionally unchecked.
- The **Remove the alpha label** section at the end is the exact, ordered procedure to run once every box above it is checked.

---

## Required automation

| # | Item | Result | Notes |
|---|------|--------|-------|
| 1 | Clean frozen dependency install | ✅ Pass | `rm -rf node_modules && pnpm install --frozen-lockfile` — no lockfile drift, no ignored-settings warning (see [pnpm workspace fix](#fixes-made-during-this-pass)). |
| 2 | Formatting (`pnpm format:check`) | ✅ Pass | Fixed via `prettier --write` on the ~28 files this stabilization work had touched (no unrelated files reformatted). |
| 3 | Lint (`pnpm lint`) | ✅ Pass | 0 errors. 21 pre-existing warnings remain (`no-explicit-any` in provider proxies/settings migrations, one `no-console`, one `react-hooks/exhaustive-deps`) — none introduced by this pass; see [Known follow-ups](#known-follow-ups-not-blocking). |
| 4 | Server typecheck (`pnpm typecheck:server`) | ✅ Pass | Clean. |
| 5 | Client typecheck (`pnpm typecheck:client`) | ✅ Pass | Clean. |
| 6 | Unit/integration tests (`pnpm test`, full suite) | ✅ Pass | **304 passed, 0 failed, 1 skipped**, 79 suites. Includes the OpenAPI contract tests (`server/api/openapi-{trakt,request-filters,media-actions,mdblist}-contract.test.ts`) and both upgrade-matrix tests. |
| 7 | Production build (`pnpm build`) | ✅ Pass | `next build` + `build:server` (tsc + asset copy) both succeeded. |
| 8 | SQLite fresh-install migrations + schema invariants | ✅ Pass | `pnpm check:migrations` (sqlite leg). |
| 9 | PostgreSQL fresh-install migrations + schema invariants | ✅ Pass | Ran against a throwaway `postgres:16-alpine` container (matches CI's service container). Skips gracefully with a clear message when `DB_HOST`/`DB_USER`/`DB_PASS` aren't set. |
| 10 | SQLite upgrade-matrix test (upstream Seerr baseline → current schema) | ✅ Pass | `server/migration/upgradeMatrix.sqlite.test.ts` — asserts users/settings/requests/media/service config survive, not just that migrations run. |
| 11 | PostgreSQL upgrade-matrix test | ✅ Pass | `server/migration/upgradeMatrix.postgres.test.ts`, run against the same throwaway Postgres container. |
| 12 | Helm lint (`helm lint charts/foreseer-chart`) | ✅ Pass | Only an informational "icon is recommended" note. |
| 13 | Helm renders the intended default image tag | ✅ Pass (after fix) | See [Fixes made during this pass](#fixes-made-during-this-pass) — the CI/release check for this was broken and would have failed on every run. |
| 14 | Version consistency (`pnpm check:versions`) | ✅ Pass | `app 0.1.0-alpha.5, chart 3.7.0, image tag v0.1.0-alpha.5` — all agree. |
| 15 | OpenAPI validation / generated-client contract checks | ✅ Pass | No separate generated TS client exists for this project; the closest equivalent — `express-openapi-validator` request/response validation exercised by the `openapi-*-contract.test.ts` suites — passed as part of item 6. |

### Fixes made during this pass

These were found while running the automation above and fixed as part of closing out Phase 1/5, not new feature work:

1. **pnpm workspace configuration (last Phase 1 item).** `pnpm-workspace.yaml` did not exist, so pnpm 10 silently ignored `package.json#pnpm.{onlyBuiltDependencies,overrides}` on every install (confirmed via `pnpm install` warning: `The "pnpm" field in package.json is no longer read by pnpm`). Moved both keys into a new `pnpm-workspace.yaml` and removed the dead `pnpm` block from `package.json`. A clean `rm -rf node_modules && pnpm install --frozen-lockfile` now installs with no ignored-settings warning.
2. **Broken Helm image-tag CI check.** The "Verify default image tag" step added in `.github/workflows/ci.yml` and `.github/workflows/release.yml` compared an unquoted `expected_tag` against `helm template ... | awk '/image:/{print $2; exit}'`, but the rendered chart quotes the image (`image: "ghcr.io/..."`), so `$2` always included the surrounding quotes and the comparison always failed. This means the check had never actually passed and would have blocked every PR merge to `develop`/`main` and every tagged release. Fixed by extracting the field with `awk -F'"'` instead, so the quotes aren't included. Verified locally with the exact CI command.
3. **Lint errors in Phase 1–4 work-in-progress files.** Fixed 9 real ESLint errors (unused imports/vars: `upstreamTotalPages` in `filteredPagination.ts`, unused `CollectionResult`/`MovieResult`/`PersonResult`/`TvResult` type imports in `discover.ts`, unused `UserSettings` import in `settings/index.ts`, and three test files missing the repo's established `// eslint-disable-next-line` convention above an intentionally-unused Express `_next` handler argument). No behavior changed.
4. **Formatting drift.** Ran `prettier --write` on exactly the ~28 files `format:check` flagged (all files already touched by Phase 1–4 work); did not reformat the rest of the repo.

### Stale version/registry references fixed in documentation

Found while checking "replace stale hard-coded alpha/Seerr v3 tags":

- `docs/using-seerr/advanced/verifying-signed-artifacts.mdx` was an unedited copy of upstream Seerr's own guide: it referenced `ghcr.io/seerr-team/seerr`, Docker Hub `seerr/seerr`, and `seerr-team/seerr` workflow/certificate identities throughout — none of which are Foreseer's actual registries (`ghcr.io/selmant/seerr`, `selmantr/foreseer`) or repo (`selmant/seerr`). Rewrote it end-to-end to match Foreseer's actual `release.yml`/`helm.yml` publishing pipeline (including the chart's real OCI path `ghcr.io/selmant/seerr/foreseer-chart` and the helm workflow's real trigger ref `refs/heads/develop`, not `main`).
- Swept the rest of `docs/**` for the same `seerr-team/seerr` mistake (wrong GitHub org for a Foreseer-authored doc) — fixed in `docs/migration-guide.mdx`, `docs/getting-started/kubernetes.mdx`, `docs/getting-started/buildfromsource.mdx`, `docs/getting-started/third-parties/unraid.mdx`, `docs/using-seerr/advanced/self-signed-certificates.mdx`, `docs/using-seerr/notifications/index.mdx`, `docs/using-seerr/notifications/pushover.md`, and `docs/README.md`. (Left `gen-docs/**` alone — that's the vendored upstream Docusaurus site/blog, which is legitimately about upstream Seerr's own release history.)
- `docs/migration-guide.mdx` pinned Docker Compose examples to the stale `v0.1.0-alpha.3` tag; bumped to `v0.1.0-alpha.5`.
- `docs/migration-guide.mdx` and `docs/getting-started/docker.mdx` both described Docker tag conventions using Seerr's own `v3.0.0`/`v3`/`v3.0` version-series examples, which will never be accurate for Foreseer (Foreseer is not on Seerr's major-version track). Changed the examples to Foreseer's own `v0.1.0`/`v0`/`v0.1`.
- `charts/foreseer-chart/Chart.yaml` `appVersion` was still `v3.3.0` (an upstream Seerr version) instead of Foreseer's own `v0.1.0-alpha.5` — **this was already fixed as uncommitted Phase 1 work** before this pass started; confirmed it's correct and that `pnpm check:versions` agrees.

### Known follow-ups (not blocking)

- `docs/migration-guide.mdx` still contains a large second half (roughly "Migrating from Seerr to Foreseer" onward past the Docker/K8s/third-party sections) that reads as a wholesale copy of upstream Seerr's own Overseerr/Jellyseerr-to-Seerr migration guide, mixed in with Foreseer-specific content at the top. The obviously-wrong literal strings (`seerr-team/seerr`, stale alpha tags, `v3.x` tag examples) are fixed, but the doc's structure/narrative wasn't restructured — that's a content-editorial task, not a version/tag fix, and is out of scope for this pass.
- Pre-existing lint warnings (21, listed in automation item 3) are untouched; none block the gate but are candidates for cleanup before or shortly after stable.
- A local Postgres was spun up manually (`docker run postgres:16-alpine`) to validate items 9 and 11 end-to-end; CI already does this via a service container on every push to `develop`/`main` and on release tags, so this was a one-time local confirmation, not a permanent process change.

---

## Required manual validation

None of the items below can be completed by an agent — they need a human with real credentials and real downstream services (Trakt account, MDBList API key, Radarr/Sonarr/media-server instances, and non-trivial real-world SQLite/PostgreSQL data). **Every box is intentionally unchecked.**

### Trakt

- [ ] Link a Trakt account via device auth.
- [ ] Unlink a linked Trakt account.
- [ ] Relink the same Trakt account after unlinking.
- [ ] Switch a linked Foreseer user to a *different* Trakt account and confirm the old account's cache/tokens are fully invalidated.
- [ ] Attempt to link a Trakt account that is already linked to a different Foreseer user and confirm it's rejected.
- [ ] Browse Trakt recommendations for `movie`, `tv`, `anime`, and `all`.
- [ ] Browse Trakt watchlist for `movie`, `tv`, `anime`, and `all`.
- [ ] Browse Trakt history for `movie`, `tv`, `anime`, and `all`.
- [ ] Browse a public/custom Trakt list for `movie`, `tv`, `anime`, and `all`.
- [ ] For `all` media, confirm movies and shows interleave in a single globally chronological order (not "page of movies then page of shows").
- [ ] Page forward across at least 3 pagination boundaries for a mixed-media (`all`) browse and confirm no duplicates and no skipped items.
- [ ] Confirm a requested page size (e.g. 20) never returns more than that many items for `all` media.
- [ ] Mark an item watched; confirm it reflects immediately and after a page reload.
- [ ] Mark an item unwatched; confirm it reflects immediately and after a page reload.
- [ ] Add a rating; confirm it reflects immediately.
- [ ] Remove a rating; confirm it reflects immediately.
- [ ] Simulate a Trakt write failure (e.g. revoke the app token, or block the Trakt API at the network level) while marking watched/rating, and confirm the UI shows an actionable error and does **not** show the action as having succeeded.
- [ ] Change the *application-level* Trakt client ID/secret in admin settings with users linked, and confirm the confirmation prompt appears and no accounts are disconnected until the save succeeds.

### MDBList

- [ ] Confirm rating badges render correctly with a valid MDBList API key configured.
- [ ] Confirm MDBList-based filters work as expected (e.g. minimum rating filter).
- [ ] Disable all MDBList badges and confirm no MDBList calls are made for pages that don't need them (check logs/metrics).
- [ ] Remove/clear the MDBList API key via the dedicated clear control and confirm the UI reflects "no key configured" (not a masked placeholder).
- [ ] Confirm the real MDBList key is never returned in any API response or visible in logs.
- [ ] Confirm MDBList response caching behaves as expected (repeat requests within the cache window don't re-hit the provider).
- [ ] Simulate MDBList rate-limiting (or hit real limits) and confirm the app degrades gracefully instead of failing the whole page.

### Request routing

- [ ] Configure at least two Radarr servers and two Sonarr servers (including one anime-tagged route and one 4K route).
- [ ] Submit a normal movie request and confirm it routes to the correct server/profile/root folder/tags.
- [ ] Submit a normal TV request and confirm the same.
- [ ] Submit an anime movie and an anime TV request and confirm they route to the anime-specific server/profile.
- [ ] Submit a 4K movie and TV request and confirm they route to the 4K server/profile.
- [ ] Confirm no request can end up with a profile/root-folder/tag combination that belongs to a *different* server than the one selected.

### Upgrade validation with real data

- [ ] Take a backup of a real (sanitized) SQLite database, then upgrade a copy to this build and verify users/settings/requests/media/service integrations are intact and the app runs correctly against it (not just that migrations exit 0).
- [ ] Do the same for a real (sanitized) PostgreSQL database.
- [ ] Confirm the pre-upgrade backup restores cleanly if the upgrade needs to be rolled back.

### Default installs

- [ ] Install via Docker Compose using only the documented example (`docs/getting-started/docker.mdx`) and confirm it comes up healthy with no undocumented steps.
- [ ] Install via Helm using only chart defaults (`helm install foreseer oci://ghcr.io/selmant/seerr/foreseer-chart`) and confirm it comes up healthy with no undocumented values overrides.

---

## Release documentation

| Item | Status |
|------|--------|
| Supported upgrade sources + minimum platform/database versions published | ✅ In [`docs/stable-contract.md`](/stable-contract) and [`docs/release-notes-draft.md`](/release-notes-draft). Minimum versions: Node `^22.19.0`, pnpm `^10.0.0` (`package.json#engines`), PostgreSQL `16` (CI/local validation target; earlier 1x versions are not tested), SQLite bundled via `sqlite3`. |
| Intentional alpha-breaking changes documented | ✅ Captured across Phase 1–4 commits/tests; the stabilization plan (`plan.md`) is the authoritative list of what changed and why. Consider folding a condensed "breaking changes" bullet list into the real release notes when cutting stable — the raw plan is maintainer-facing, not release-note prose. |
| Backup and rollback instructions published | ✅ [`docs/using-seerr/backups.md`](/using-seerr/backups) (SQLite/PostgreSQL/Docker/Kubernetes backup + restore + upgrade/downgrade policy). |
| Stale hard-coded alpha/Seerr v3 tags replaced | ✅ See [Stale version/registry references fixed](#stale-version-registry-references-fixed-in-documentation) above. |
| Deprecation policy for future API/settings changes | ✅ See [below](#deprecation-policy-new). |
| Application/container/chart/docs/release-note versions agree | ✅ `pnpm check:versions` passes for `0.1.0-alpha.5` (see automation item 14). Re-run after the version bump described below. |

### Deprecation policy (new)

Once stable, Foreseer follows SemVer for the application version (`package.json#version`) independently from the Helm chart version (`charts/foreseer-chart/Chart.yaml#version`), matching the working rule already encoded in `scripts/check-version-consistency.mjs`.

- **Database migrations and `settings.json` migrators are append-only forever after the first stable release.** A migration that has shipped in a stable release is never edited or removed; a breaking or structural change ships as a new migration/migrator that transforms the old shape into the new one.
- **REST API removals/renames are deprecated for at least one minor release before removal.** A field or endpoint slated for removal is marked deprecated (in `seerr-api.yml` description and, where practical, a runtime deprecation signal — see `server/middleware/deprecation.ts`) in the minor release where the replacement ships, and removed no earlier than the *next* minor release. Patch releases never remove or rename a public API field/endpoint.
- **Settings fields follow the same one-minor-release deprecation window.** A renamed/restructured settings field keeps a migrator that reads the old shape for at least one minor release; unknown/legacy fields are preserved rather than silently dropped during that window.
- **Breaking changes always ship in a new minor version at minimum** (Foreseer is pre-1.0, so breaking changes may still ship in a minor bump per SemVer's `0.y.z` rules; after `1.0.0`, breaking changes require a major bump). Every breaking change is called out explicitly in that release's notes, not just in the changelog diff.
- **This policy itself is versioned with the docs**: if it changes, update this section and note the change in the release that changes it.

---

## Remove the alpha label

**Do not perform these steps until every box in [Required manual validation](#required-manual-validation) above is checked and the automation in [Required automation](#required-automation) has been re-run clean on the commit being released.**

1. **Re-run all automation** in this document against the exact commit being released (not an older snapshot). Fix anything that regressed.
2. **Bump the application version** in `package.json` from `0.1.0-alpha.5` to the target stable version (e.g. `0.1.0` or `1.0.0` — pick per the deprecation-policy SemVer rules above; going pre-1.0 → 1.0.0 is the more conservative signal for "first stable" but either satisfies the tooling as long as it's a valid, non-prerelease SemVer string).
3. **Update `charts/foreseer-chart/Chart.yaml#appVersion`** to `v<new-version>` (must exactly match `v` + the new `package.json#version`; this is enforced by `scripts/check-version-consistency.mjs`).
4. **Do not manually set `values.yaml#image.tag`** — it defaults to `.Chart.AppVersion` via `image.tag | default .Chart.AppVersion` in `charts/foreseer-chart/templates/statefulset.yaml`; leaving it empty is correct and is what the version-consistency script expects.
5. Decide whether to bump `charts/foreseer-chart/Chart.yaml#version` (the chart's own independent SemVer) at the same time — it is not required to match the app version, but a stable app release is a reasonable point to bump it if chart changes have accumulated.
6. **Update alpha-specific documentation** so it no longer describes alpha-only caveats as current:
   - [`docs/using-seerr/backups.md`](/using-seerr/backups) → replace the "Alpha-to-stable migration policy" warning with a plain statement that all migrations from the stable release onward are backward compatible.
   - [`docs/release-notes-draft.md`](/release-notes-draft) → fold its content into the real release announcement/changelog for this version, then delete or archive the draft file.
   - `README.md` → replace the `> [!WARNING] Foreseer is currently in alpha (...)` banner with stable-release messaging (or remove it).
   - `docs/migration-guide.mdx` → the `:::danger Foreseer is currently alpha software...` block should be softened or removed once the upgrade paths in this document have real-world validation (i.e. once [Required manual validation](#required-manual-validation) is fully checked).
7. **Run `pnpm check:versions`** and confirm it reports the new version with no errors.
8. **Tag the release** (`vX.Y.Z`, matching the new `package.json#version` with a leading `v`) — this triggers `.github/workflows/release.yml`, which re-runs the full quality gate against the tagged commit before publishing.
9. **Add the previous-Foreseer-stable upgrade fixture** described in `docs/release-notes-draft.md` (upgrade-from-this-stable-release test) so the *next* release has real upgrade coverage from this one, not just from the upstream Seerr baseline.
