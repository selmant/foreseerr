---
title: Stable release gate
---

:::info Status
Maintainer-facing checklist for cutting a Foreseerr stable release. The alpha-removal procedure that lived here was completed for **`v0.1.0`**; the app is currently **`v0.14.1`** stable. Use this document when preparing the **next** stable tag, not as a gate to “leave alpha.”
:::

## Current state

| Item | Status |
| --- | --- |
| First stable (`v0.1.0`) | Shipped; alpha label removed |
| Current app version | `package.json` → `0.14.1` |
| Supported upgrade sources | See [`docs/stable-contract.md`](./stable-contract.md) |
| Historical alpha checklist | Retired; automation snapshot below was for `0.1.0-alpha.5` and is not a live gate |

## Before cutting the next stable

Re-run these on the exact commit you will tag. Prefer GitHub Actions results over a one-off local snapshot.

### Required automation (GitHub CI)

| # | Item | How |
| --- | --- | --- |
| 1 | Frozen install | `bun install --frozen-lockfile` |
| 2 | Format / lint / typecheck / unit tests / web build | `.github/workflows/ci.yml` `test` + `unit-test` jobs |
| 3 | Backend format / clippy / tests | `.github/workflows/backend-rs.yml` |
| 4 | Fresh-install migrations and startup (SQLite + PostgreSQL) | `migration-test` job in `ci.yml` (`backend-rs/scripts/ci-smoke.py`) |
| 5 | Version consistency | `bun run check:versions` |
| 6 | Helm lint + default image tag | `helm-lint` job |
| 7 | OpenAPI request validation | `cargo test` in `backend-rs/` (`src/openapi/`) |

### Required manual smoke (human)

Keep this short; full Trakt/MDBList/Arr matrices from the alpha era are not a release blocker once CI is green:

- [ ] Link / unlink Trakt (or Better Trakt) on a real Jellyfin-backed install
- [ ] Request movie + TV (+ episode pick if used) against real Radarr/Sonarr
- [ ] Upgrade a backup of a real SQLite **or** PostgreSQL DB from the previous stable and confirm users/settings/requests survive
- [ ] Docker Compose and/or Helm install from published docs comes up healthy

## Cut procedure

1. Re-run automation on the release commit; fix regressions.
2. Bump `package.json#version` and `charts/foreseerr-chart/Chart.yaml#appVersion` (`v` + same version). Leave `values.yaml#image.tag` empty so it defaults to AppVersion.
3. Optionally bump the chart’s own `Chart.yaml#version`.
4. Update release notes under `docs/release-notes-*.md` and any versioned README banners.
5. Run `bun run check:versions`.
6. Tag `vX.Y.Z` to trigger `.github/workflows/release.yml`.
7. Check that the release attached the server archives (`foreseerr-*.tar.gz`/`.zip`, the `foreseerr-plugin-*` ones) and `SHA256SUMS`; the Jellyfin plugin and Foreseer Desktop download them.

## Deprecation policy

Unchanged from the first stable:

- Migrations and `settings.json` migrators are append-only after a stable ships.
- REST API removals/renames need at least one minor deprecation window.
- Settings renames keep a migrator for at least one minor.
- Breaking changes ship in a new minor (pre-1.0) or major (post-1.0) and are called out in release notes.
