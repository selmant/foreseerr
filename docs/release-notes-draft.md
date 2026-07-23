---
title: Release notes draft (alpha-to-stable policy)
---

:::info Status
This is a maintainer-facing draft, not published documentation. It exists so the alpha-to-stable migration/reset policy is written down and reviewable before the first stable release, per the Foreseerr stabilization plan (Phase 4). Fold the relevant sections into the actual stable-release announcement/changelog when that release ships, then delete or archive this file.
:::

## Upgrade sources supported at stable

At the first stable release, Foreseerr will support upgrading in place from:

1. A fresh Foreseerr installation.
2. An upstream Seerr SQLite or PostgreSQL database, validated against the Seerr merge-base commit `759e35933860594282bd929587576b003a3efb2d`.
3. A previous stable Foreseerr release, once one exists. _(No stable release exists yet — this source has no fixture/tests yet. Add a previous-Foreseerr-stable fixture and upgrade test alongside `server/migration/upgradeMatrix.sqlite.test.ts` / `.postgres.test.ts` as part of cutting the first stable release, and remove this note once that's done.)_

Automated coverage: `pnpm check:migrations` (fresh-install matrix, both engines) and `server/migration/upgradeMatrix.{sqlite,postgres}.test.ts` (upgrade-from-baseline matrix, asserting data survives — not just that migrations run).

## Alpha-to-stable migration/reset policy

Foreseerr is alpha software today (`0.1.0-alpha.x`). Until the first stable release:

- **No backward-compatibility guarantee between alpha builds.** Database migrations and `settings.json` migrators are still append-only and forward-only (we do not rewrite or remove a migration once it has shipped), but the alpha line has not been validated for every alpha-to-alpha upgrade path the way stable releases will be.
- **Recommended path for alpha users hitting a broken upgrade:** restore the pre-upgrade backup (see [Backups](/using-seerr/backups)) or perform a fresh install and reconfigure. There is currently no supported automated recovery beyond restoring a backup.
- **Downgrading is never supported**, alpha or stable. Foreseerr detects a database or `settings.json` that records migrations the running version doesn't recognize and refuses to start with an actionable error instead of silently running against an unknown schema (see `assertSupportedDatabaseSchema` in `server/lib/db/schemaGuard.ts` and the equivalent check in `server/lib/settings/migrator.ts`).

## What changes once stable ships

- The warning above in [Backups → Upgrading and downgrading](/using-seerr/backups) should be updated to state plainly that all migrations from the stable release onward are backward compatible, and that upgrades are always expected to apply cleanly.
- Add the previous-Foreseerr-stable fixture/tests described above.
- Publish the exact stable version number and its supported upgrade sources in the real release notes/announcement.
