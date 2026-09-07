import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { setupTestDb } from '@server/test/db';
import { executeManagedJob } from './execution';

setupTestDb();

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('managed job executor', { concurrency: false }, () => {
  it('runs a deferred light job when a slot frees instead of dropping it', async () => {
    let releaseFirst: () => void = () => undefined;
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let resolveThird: () => void = () => undefined;
    const thirdFinished = new Promise<void>((resolve) => {
      resolveThird = resolve;
    });

    const first = executeManagedJob('light-a', 'light', async () => {
      await firstHold;
    });
    const second = executeManagedJob('light-b', 'light', async () => {
      await wait(30);
    });
    const thirdAdmitted = await executeManagedJob(
      'light-c',
      'light',
      async () => {
        resolveThird();
      }
    );

    assert.equal(thirdAdmitted, false);

    releaseFirst();
    await first;
    await second;
    await Promise.race([
      thirdFinished,
      wait(1000).then(() => {
        throw new Error('deferred light job did not run');
      }),
    ]);
  });

  it('coalesces a second invocation of the same job until the first finishes', async () => {
    let releaseFirst: () => void = () => undefined;
    const firstHold = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let resolveEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      resolveEntered = resolve;
    });
    let runs = 0;

    const first = executeManagedJob('same-id', 'light', async () => {
      runs += 1;
      resolveEntered();
      await firstHold;
    });
    await entered;
    const overlapping = await executeManagedJob(
      'same-id',
      'light',
      async () => {
        runs += 1;
      }
    );

    assert.equal(overlapping, false);
    assert.equal(runs, 1);

    releaseFirst();
    await first;
    await wait(200);
    assert.equal(runs, 2);
  });
});
