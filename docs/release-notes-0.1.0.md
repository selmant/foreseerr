---
title: Foreseerr v0.1.0 release notes
---

:::info Status
First stable Foreseerr release. Maintainer tracking for the cut lives in [`docs/stable-release-gate.md`](/stable-release-gate); this page is the user-facing summary of supported upgrades and policy.
:::

## Highlights

- First stable Foreseerr release (`v0.1.0`), built on Seerr with in-app Trakt browse, multi-source ratings, and related discovery workflows.
- Config paths remain Seerr-compatible (`CONFIG_DIRECTORY`, Docker `/app/config`).
- Image: `ghcr.io/selmant/foreseerr:v0.1.0` (also published to Docker Hub as `selmantr/foreseerr`).
- Helm chart: `oci://ghcr.io/selmant/foreseerr/foreseerr-chart` (`version` / `appVersion` `0.1.0` / `v0.1.0`). Chart SemVer was reset from the inherited Seerr `3.x` line to match the first Foreseerr stable.

## Supported upgrade sources

Foreseerr `v0.1.0` supports upgrading in place from:

1. A fresh Foreseerr installation.
2. An upstream Seerr SQLite or PostgreSQL database, validated against the Seerr merge-base commit `759e35933860594282bd929587576b003a3efb2d`.
3. A previous stable Foreseerr release — none existed before `v0.1.0`; later stables use `v0.1.0` as the first Foreseerr-stable upgrade source (`server/migration/foreseerrStableBaseline.ts`).

Automated coverage: `pnpm check:migrations` (fresh-install matrix, both engines), `server/migration/upgradeMatrix.{sqlite,postgres}.test.ts` (Seerr baseline → current), and `server/migration/upgradeMatrix.foreseerrStable.sqlite.test.ts` (Foreseerr `v0.1.0` → current).

See the [migration guide](/migration-guide) for the evergreen Seerr → Foreseerr procedure.

## Alpha builds are not supported

- There is **no** supported upgrade path from `0.1.0-alpha.x` to `v0.1.0`.
- Alpha users should restore a pre-alpha backup of Seerr (if migrating), or perform a fresh Foreseerr install and reconfigure.
- Downgrading is never supported. Foreseerr refuses to start if the database or `settings.json` records migrations the running version does not recognize (see [Backups](/using-seerr/backups)).

## Breaking / policy notes for this release

- Database migrations and `settings.json` migrators are append-only from this release forward.
- REST API and settings deprecations follow the one-minor-release window documented in [`docs/stable-release-gate.md`](/stable-release-gate).
