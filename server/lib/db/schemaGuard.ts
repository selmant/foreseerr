import logger from '@server/logger';
import type { DataSource } from 'typeorm';

const collectErrorMessages = (error: unknown): string[] => {
  const messages: string[] = [];
  if (error instanceof Error && error.message) {
    messages.push(error.message);
  } else if (typeof error === 'string') {
    messages.push(error);
  }
  const driverError = (error as { driverError?: { message?: string } })
    ?.driverError;
  if (driverError?.message) {
    messages.push(driverError.message);
  }
  return messages;
};

/**
 * Only a missing `migrations` table is boot-ok (fresh database). Permission,
 * connection, and any other read errors must fail closed.
 */
export const isMissingMigrationsTableError = (error: unknown): boolean => {
  const message = collectErrorMessages(error).join(' ');
  if (!/migrations/i.test(message)) {
    return false;
  }
  return (
    /no such table/i.test(message) ||
    /relation .+ does not exist/i.test(message)
  );
};

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
  // Match TypeORM MigrationExecutor: prefer an explicit `name` field, else
  // fall back to the class name. Older upstream migrations omit `name`, and
  // using only `.name` falsely treats them as unrecognized (Cypress/prod).
  const knownMigrationNames = new Set(
    dataSource.migrations.flatMap((migration) => {
      if (migration.name) {
        return [migration.name];
      }
      const ctorName = migration.constructor?.name;
      if (ctorName && ctorName !== 'Object' && ctorName !== 'Function') {
        return [ctorName];
      }
      return [];
    })
  );

  let executedMigrations: { name: string }[];
  try {
    executedMigrations = await dataSource.query('SELECT name FROM migrations');
  } catch (error) {
    if (isMissingMigrationsTableError(error)) {
      // Brand-new database that hasn't been migrated yet.
      return;
    }
    logger.error('Failed to read the migrations table; refusing to start.', {
      label: 'Database',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    throw error;
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
