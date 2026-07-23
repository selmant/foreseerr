/**
 * Phase 0 upgrade-source baseline.
 *
 * Foreseerr's schema/migration history is a direct continuation of upstream
 * Seerr's. The commit below is the upstream Seerr merge-base this fork
 * diverged from, and it is the "upstream Seerr SQLite/PostgreSQL database"
 * upgrade source referenced by the stabilization plan (Phase 0/4).
 *
 * `UPSTREAM_BASELINE_LAST_SHARED_MIGRATION_TIMESTAMP` is the timestamp of the
 * last migration file that is byte-for-byte identical between that upstream
 * commit and this codebase (`AddDiscordIdsColumn`, sqlite and postgres alike).
 * Every migration with a strictly greater timestamp is a Foreseerr-only
 * addition. This lets upgrade tests reconstruct "a database created by
 * upstream Seerr at the baseline commit" by only replaying migrations up to
 * the cutoff, then replaying the remaining Foreseerr-only migrations to bring
 * it current — without having to vendor a real upstream database file.
 *
 * If you add a new migration, nothing here needs to change: the cutoff only
 * moves when upstream Seerr code is re-synced into this fork.
 */
export const UPSTREAM_BASELINE_COMMIT =
  '759e35933860594282bd929587576b003a3efb2d';

export const UPSTREAM_BASELINE_LAST_SHARED_MIGRATION_TIMESTAMP = 1779783365432;
