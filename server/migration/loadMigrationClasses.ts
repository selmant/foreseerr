import { glob } from 'node:fs/promises';
import { join } from 'node:path';
import type { MigrationInterface } from 'typeorm';

export type MigrationClass = new () => MigrationInterface;

/**
 * Loads TypeORM migration classes directly (instead of relying on TypeORM's
 * glob-string resolution), optionally filtered by the numeric timestamp
 * prefix in the filename (e.g. `1784500000000-AddTraktUserIdUserSetting.ts`).
 *
 * Used by upgrade-matrix tests to run "only the migrations upstream Seerr
 * shipped as of the baseline commit" against a fresh database, then replay
 * the remaining Foreseerr-only migrations to simulate an in-place upgrade.
 */
export async function loadMigrationClasses(
  migrationsDir: string,
  options: { maxTimestamp?: number } = {}
): Promise<MigrationClass[]> {
  const entries: string[] = [];
  for await (const entry of glob(join(migrationsDir, '*.ts'))) {
    entries.push(entry);
  }
  entries.sort();

  const classes: MigrationClass[] = [];
  for (const entry of entries) {
    const match = /^(\d+)-/.exec(entry.split('/').pop() ?? '');
    if (!match) {
      continue;
    }
    const timestamp = Number(match[1]);
    if (
      options.maxTimestamp !== undefined &&
      timestamp > options.maxTimestamp
    ) {
      continue;
    }

    const mod = await import(entry);
    const exported = Object.values(mod).find(
      (value): value is MigrationClass => typeof value === 'function'
    );
    if (!exported) {
      throw new Error(`No migration class export found in ${entry}`);
    }
    classes.push(exported);
  }

  return classes;
}
