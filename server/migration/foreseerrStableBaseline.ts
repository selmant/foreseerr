/**
 * First stable Foreseerr release baseline (v0.1.0).
 *
 * `FORESEERR_V0_1_0_LAST_MIGRATION_TIMESTAMP` is the timestamp of the last
 * database migration shipped in v0.1.0 (`AddTraktUserIdUserSetting`, sqlite
 * and postgres alike). Upgrade tests for later Foreseerr releases can rebuild
 * "a database created by Foreseerr v0.1.0" by replaying migrations up to this
 * cutoff, then applying newer migrations — the same pattern as
 * `upstreamBaseline.ts` for Seerr.
 *
 * Do not move this cutoff when adding migrations after v0.1.0; only introduce
 * a new constant (e.g. `FORESEERR_V0_5_0_...`) when cutting a later stable
 * that should become an upgrade source.
 */
export const FORESEERR_V0_1_0_LAST_MIGRATION_TIMESTAMP = 1784500000000;

/**
 * Foreseerr v0.5.0 cutoff: last migration shipped with the Library / calendar
 * / desktop-ticket cluster (`AddReleaseSyncFence`). Frozen for future
 * Foreseerr→Foreseerr upgrade matrices; do not move when adding newer
 * migrations after v0.5.0.
 */
export const FORESEERR_V0_5_0_LAST_MIGRATION_TIMESTAMP = 1785910000000;
