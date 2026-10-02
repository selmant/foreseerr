import { resetMappingState } from '@server/test/mapping';
import { resetTestDb, seedTestDb } from '@server/utils/seedTestDb';
import { before, beforeEach } from 'node:test';

export function setupTestDb() {
  before(async () => {
    await seedTestDb();
  });
  beforeEach(async () => {
    await resetTestDb();
    // The preload's hooks only reach the first test file, so caches that
    // mirror the database are dropped here, with the database itself.
    resetMappingState();
  });
}
