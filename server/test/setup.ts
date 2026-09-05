import dataSource, { getRepository } from '@server/datasource';
import { MappingSourceUsage } from '@server/entity/MappingSourceUsage';
import { resetTmdbValidityCache } from '@server/lib/discover/validity';
import { clearNegativeCache, resetBudgets } from '@server/lib/mapping/budget';
import { resetMappingGapBuffer } from '@server/lib/mapping/gaps';
import { resetSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { after, afterEach, before } from 'node:test';

before(() => {
  if (process.env.VERBOSE != 'true') logger.silent = true;
});

afterEach(async () => {
  resetMappingGapBuffer();
  resetSettings();
  resetBudgets();
  clearNegativeCache();
  resetTmdbValidityCache();
  if (dataSource.isInitialized) {
    try {
      await getRepository(MappingSourceUsage).clear();
    } catch {
      // Schema may not exist in files that never open the test DB.
    }
  }
});

after(() => {
  if (process.env.VERBOSE != 'true') logger.silent = false;
});
