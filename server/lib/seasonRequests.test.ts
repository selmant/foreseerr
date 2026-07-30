import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { MediaStatus } from '@server/constants/media';
import { isSeasonFullyAvailable } from '@server/lib/seasonRequests';

describe('isSeasonFullyAvailable', () => {
  it('only treats a completely available season as covered', () => {
    assert.strictEqual(isSeasonFullyAvailable(MediaStatus.AVAILABLE), true);
    assert.strictEqual(
      isSeasonFullyAvailable(MediaStatus.PARTIALLY_AVAILABLE),
      false
    );
    assert.strictEqual(isSeasonFullyAvailable(MediaStatus.PROCESSING), false);
    assert.strictEqual(isSeasonFullyAvailable(MediaStatus.UNKNOWN), false);
    assert.strictEqual(isSeasonFullyAvailable(MediaStatus.DELETED), false);
  });
});
