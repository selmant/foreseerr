// The process entry point is intentionally separate from server construction.
// Tests and embedding launchers can import `startForeseerr` without opening a
// listener; Docker and the desktop managed child use this module instead.
import { startForeseerr } from '@server/index';
import logger from '@server/logger';

startForeseerr().catch((error: Error & { exitCode?: number }) => {
  logger.error(error.stack ?? error.message);
  process.exit(error.exitCode ?? 1);
});
