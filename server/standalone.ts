// Compile-only process entry. Docker and `bun dist/launcher.js` keep using
// launcher.ts so production globs stay on disk. This module statically
// imports TypeORM classes so bun --compile does not need dist/**/*.js.
import { setCompileOrm } from '@server/datasource';
import {
  compileEntities,
  compilePostgresMigrations,
  compileSqliteMigrations,
  compileSubscribers,
} from '@server/lib/db/compileRegistry';
import '@server/lib/settings/settingsMigrationModules';
import { startForeseerr } from '@server/index';
import logger from '@server/logger';

setCompileOrm({
  entities: [...compileEntities],
  subscribers: [...compileSubscribers],
  sqliteMigrations: [...compileSqliteMigrations],
  postgresMigrations: [...compilePostgresMigrations],
});

startForeseerr().catch((error: Error & { exitCode?: number }) => {
  logger.error(error.stack ?? error.message);
  process.exit(error.exitCode ?? 1);
});
