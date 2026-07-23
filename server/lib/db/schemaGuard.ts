import logger from '@server/logger';
import type { DataSource } from 'typeorm';

/**
 * Detects a database that was migrated by a newer version of Foreseerr than
 * this one recognizes, and refuses to continue rather than running against
 * a schema this build doesn't fully understand. Downgrading a database is
 * not supported; the actionable fix is to restore a backup taken before the
 * upgrade, or upgrade this install instead.
 *
 * Must run after `dataSource.runMigrations()` (or at least after
 * `dataSource.initialize()`), so `dataSource.migrations` reflects the
 * migration classes this build ships.
 */
export async function assertSupportedDatabaseSchema(
  dataSource: DataSource
): Promise<void> {
  const knownMigrationNames = new Set(
    dataSource.migrations.map((migration) => migration.name)
  );

  let executedMigrations: { name: string }[];
  try {
    executedMigrations = await dataSource.query('SELECT name FROM migrations');
  } catch {
    // The migrations table doesn't exist yet (e.g. a brand-new database
    // that hasn't been migrated). Nothing to compare against.
    return;
  }

  const unknownMigrations = executedMigrations
    .map((row) => row.name)
    .filter((name) => !knownMigrationNames.has(name));

  if (unknownMigrations.length === 0) {
    return;
  }

  logger.error(
    `This database was migrated by a newer version of Foreseerr and includes migrations this version does not recognize: ${unknownMigrations.join(
      ', '
    )}.`,
    { label: 'Database' }
  );
  logger.error(
    'Downgrading a database to an older Foreseerr version is not supported. Restore a backup taken before the upgrade, or upgrade to a Foreseerr release that recognizes these migrations. See the Backups documentation for restore procedures.',
    { label: 'Database' }
  );
  throw new Error(
    'Unsupported database schema: unrecognized migrations detected.'
  );
}
