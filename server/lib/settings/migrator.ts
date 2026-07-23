import type { AllSettings } from '@server/lib/settings';
import logger from '@server/logger';
import fs from 'fs/promises';
import path from 'path';

const migrationsDir = path.join(__dirname, 'migrations');

/**
 * Detects a settings.json produced by a newer Foreseer version than this
 * one recognizes (i.e. it records a migration name this build has no
 * migration file for) and refuses to continue rather than silently running
 * this version's migrations against a schema it doesn't fully understand.
 * Downgrading is not supported; the actionable fix is to restore a
 * settings.json backup that matches this version, or upgrade instead.
 *
 * This intentionally runs before any backup/migration side effects so a
 * downgrade attempt leaves the settings file untouched.
 */
const assertNoUnsupportedMigrations = (
  settings: AllSettings,
  knownMigrationNames: string[]
): void => {
  const recordedMigrations = Array.isArray(
    (settings as { migrations?: unknown }).migrations
  )
    ? ((settings as { migrations: string[] }).migrations ?? [])
    : [];

  const unknownMigrations = recordedMigrations.filter(
    (name) => !knownMigrationNames.includes(name)
  );

  if (unknownMigrations.length === 0) {
    return;
  }

  logger.error(
    `This settings.json was migrated by a newer version of Foreseer and includes migrations this version does not recognize: ${unknownMigrations.join(
      ', '
    )}.`,
    { label: 'Settings Migrator' }
  );
  logger.error(
    'Downgrading to an older Foreseer version with a newer settings.json is not supported. Restore a settings.json backup that matches this version (see settings.old.json in your config directory), or upgrade to a Foreseer release that recognizes these migrations.',
    { label: 'Settings Migrator' }
  );
  process.exit(1);
};

export const runMigrations = async (
  settings: AllSettings,
  SETTINGS_PATH: string
): Promise<AllSettings> => {
  let migrated = settings;

  const migrations = (await fs.readdir(migrationsDir)).filter(
    (file) => file.endsWith('.js') || file.endsWith('.ts')
  );
  const knownMigrationNames = migrations.map((file) =>
    file.replace(/\.(js|ts)$/, '')
  );

  assertNoUnsupportedMigrations(settings, knownMigrationNames);

  try {
    // we read old backup and create a backup of currents settings
    const BACKUP_PATH = SETTINGS_PATH.replace('.json', '.old.json');
    let oldBackup: string | null = null;
    try {
      oldBackup = await fs.readFile(BACKUP_PATH, 'utf-8');
    } catch {
      /* empty */
    }
    await fs.writeFile(BACKUP_PATH, JSON.stringify(settings, undefined, ' '));

    const settingsBefore = JSON.stringify(migrated);

    for (const migration of migrations) {
      try {
        logger.debug(`Checking migration '${migration}'...`, {
          label: 'Settings Migrator',
        });
        const { default: migrationFn } = await import(
          path.join(migrationsDir, migration)
        );
        const newSettings = await migrationFn(structuredClone(migrated));
        if (JSON.stringify(migrated) !== JSON.stringify(newSettings)) {
          logger.debug(`Migration '${migration}' has been applied.`, {
            label: 'Settings Migrator',
          });
        }
        migrated = newSettings;
      } catch (e) {
        // we stop Foreseer if the migration failed
        logger.error(
          `Error while running migration '${migration}': ${e.message}\n${e.stack}`,
          {
            label: 'Settings Migrator',
          }
        );
        logger.error(
          'A common cause for this error is a permission issue with your configuration folder, a network issue or a corrupted database.',
          {
            label: 'Settings Migrator',
          }
        );
        process.exit();
      }
    }

    const settingsAfter = JSON.stringify(migrated);

    if (settingsBefore !== settingsAfter) {
      // a migration occured
      // we check that the new config will be saved
      await fs.writeFile(
        SETTINGS_PATH,
        JSON.stringify(migrated, undefined, ' ')
      );
      const fileSaved = JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf-8'));
      if (JSON.stringify(fileSaved) !== settingsAfter) {
        // something went wrong while saving file
        throw new Error('Unable to save settings after migration.');
      }
    } else if (oldBackup) {
      // no migration occured
      // we save the old backup (to avoid settings.json and settings.old.json being the same)
      await fs.writeFile(BACKUP_PATH, oldBackup.toString());
    }
  } catch (e) {
    // we stop Foreseer if the migration failed
    logger.error(
      `Something went wrong while running settings migrations: ${e.message}`,
      {
        label: 'Settings Migrator',
      }
    );
    logger.error(
      'A common cause for this issue is a permission error of your configuration folder.',
      {
        label: 'Settings Migrator',
      }
    );
    process.exit();
  }

  return migrated;
};
