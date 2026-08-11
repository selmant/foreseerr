import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getRepository } from '@server/datasource';
import ReleaseDateChange from '@server/entity/ReleaseDateChange';
import ReleaseOccurrence from '@server/entity/ReleaseOccurrence';
import ReleaseSyncState from '@server/entity/ReleaseSyncState';
import restoreReleaseCalendarSyncInterval from '@server/lib/settings/migrations/0012_restore_release_calendar_sync_interval';
import { setupTestDb } from '@server/test/db';
import { reconcileServerOccurrences } from './repository';
import {
  acquireReleaseSyncLease,
  assertReleaseSyncLease,
  releaseReleaseSyncLease,
  renewReleaseSyncLease,
  type ReleaseSyncLeaseRequest,
} from './state';
import { produceReleaseEventsWithLease } from './sync';
import { emptySyncResult, type NormalizedOccurrence } from './types';

setupTestDb();

const window = {
  start: new Date('2026-08-01T00:00:00.000Z'),
  end: new Date('2026-09-30T00:00:00.000Z'),
};

const occurrence = (): NormalizedOccurrence => ({
  source: 'radarr',
  sourceServerId: 1,
  sourceItemId: 42,
  mediaType: 'movie',
  tmdbId: 9001,
  title: 'Changed only once',
  dateType: 'digital',
  startsAt: new Date('2026-08-20T00:00:00.000Z'),
  allDay: true,
  monitored: true,
  hasFile: false,
  is4k: false,
  rawDates: '{"digitalRelease":"2026-08-20"}',
});

describe('release calendar reconciliation', () => {
  it('uses a database compare-and-set lease for the same source', async () => {
    const first: ReleaseSyncLeaseRequest = {
      source: 'radarr',
      sourceServerId: 1,
      owner: 'replica-a',
    };
    const second: ReleaseSyncLeaseRequest = { ...first, owner: 'replica-b' };

    const [firstWon, secondWon] = await Promise.all([
      acquireReleaseSyncLease(first),
      acquireReleaseSyncLease(second),
    ]);
    assert.deepEqual([Boolean(firstWon), Boolean(secondWon)].sort(), [
      false,
      true,
    ]);

    const winningLease = firstWon ?? secondWon;
    const losingLease = firstWon ? second : first;
    assert.ok(winningLease);
    await releaseReleaseSyncLease(winningLease);
    assert.ok(await acquireReleaseSyncLease(losingLease));
  });

  it('fences an expired owner out of renewals, writes, and release', async () => {
    const first = await acquireReleaseSyncLease({
      source: 'radarr',
      sourceServerId: 1,
      owner: 'replica-a',
    });
    assert.ok(first);
    await getRepository(ReleaseSyncState).update(
      { source: 'radarr', sourceServerId: 1 },
      { leaseExpiresAt: new Date(0) }
    );
    const second = await acquireReleaseSyncLease({
      source: 'radarr',
      sourceServerId: 1,
      owner: 'replica-b',
    });
    assert.ok(second);
    assert.ok(second.fence > first.fence);
    assert.equal(await renewReleaseSyncLease(first), false);
    await assert.rejects(() => assertReleaseSyncLease(first));
    await assert.rejects(() =>
      reconcileServerOccurrences({
        source: 'radarr',
        sourceServerId: 1,
        occurrences: [],
        ...window,
        result: emptySyncResult(),
        initialBackfill: false,
        lease: first,
      })
    );
    let notificationStarted = false;
    await assert.rejects(() =>
      produceReleaseEventsWithLease(
        first,
        { dateChanges: [], newSeasons: [] },
        async () => {
          notificationStarted = true;
        }
      )
    );
    assert.equal(notificationStarted, false);
    await releaseReleaseSyncLease(first);
    const state = await getRepository(ReleaseSyncState).findOneByOrFail({
      source: 'radarr',
      sourceServerId: 1,
    });
    assert.equal(state.leaseOwner, 'replica-b');
  });

  it('preserves an explicit five-minute administrator schedule', () => {
    const settings = restoreReleaseCalendarSyncInterval({
      jobs: { 'release-calendar-sync': { schedule: '0 */5 * * * *' } },
      migrations: [],
    });
    assert.equal(
      settings.jobs['release-calendar-sync'].schedule,
      '0 */5 * * * *'
    );
  });

  it('does not rewrite unchanged occurrences during an incremental window', async () => {
    const initial = emptySyncResult();
    await reconcileServerOccurrences({
      source: 'radarr',
      sourceServerId: 1,
      occurrences: [occurrence()],
      ...window,
      result: initial,
      initialBackfill: true,
    });
    assert.equal(initial.inserted, 1);

    const before = await getRepository(ReleaseOccurrence).findOneByOrFail({
      source: 'radarr',
      sourceServerId: 1,
      sourceItemId: 42,
      dateType: 'digital',
    });
    const fixedSeenAt = new Date('2026-08-01T01:02:03.000Z');
    await getRepository(ReleaseOccurrence).update(
      { id: before.id },
      { lastSeenAt: fixedSeenAt, updatedAt: fixedSeenAt }
    );
    const fixedBefore = await getRepository(ReleaseOccurrence).findOneByOrFail({
      id: before.id,
    });
    const result = emptySyncResult();
    await reconcileServerOccurrences({
      source: 'radarr',
      sourceServerId: 1,
      occurrences: [occurrence()],
      ...window,
      result,
      initialBackfill: false,
    });
    const after = await getRepository(ReleaseOccurrence).findOneByOrFail({
      id: before.id,
    });

    assert.equal(result.inserted, 0);
    assert.equal(result.changed, 0);
    assert.equal(after.updatedAt.getTime(), fixedBefore.updatedAt.getTime());
    assert.equal(after.lastSeenAt.getTime(), fixedBefore.lastSeenAt.getTime());
    assert.equal(
      await getRepository(ReleaseSyncState).count(),
      0,
      'reconciliation itself does not create a coordination state'
    );
  });

  it('updates an occurrence moved into the incremental window without re-inserting it', async () => {
    const oldWindow = {
      start: new Date('2026-07-01T00:00:00.000Z'),
      end: new Date('2026-07-31T23:59:59.000Z'),
    };
    const oldOccurrence = {
      ...occurrence(),
      startsAt: new Date('2026-07-20T00:00:00.000Z'),
      rawDates: '{"digitalRelease":"2026-07-20"}',
    };
    await reconcileServerOccurrences({
      source: 'radarr',
      sourceServerId: 1,
      occurrences: [oldOccurrence],
      ...oldWindow,
      result: emptySyncResult(),
      initialBackfill: true,
    });
    const original = await getRepository(ReleaseOccurrence).findOneByOrFail({
      source: 'radarr',
      sourceServerId: 1,
      sourceItemId: 42,
      dateType: 'digital',
    });

    const result = emptySyncResult();
    await reconcileServerOccurrences({
      source: 'radarr',
      sourceServerId: 1,
      occurrences: [occurrence()],
      ...window,
      result,
      initialBackfill: false,
    });
    const moved = await getRepository(ReleaseOccurrence).findOneByOrFail({
      id: original.id,
    });

    assert.equal(await getRepository(ReleaseOccurrence).count(), 1);
    assert.equal(result.inserted, 0);
    assert.equal(moved.firstSeenAt.getTime(), original.firstSeenAt.getTime());
    assert.equal(
      moved.startsAt.toISOString(),
      occurrence().startsAt.toISOString()
    );
  });

  it('updates changed occurrences that already have date-change history', async () => {
    // Existing rows are updated by primary key (save), not upserted. That keeps
    // release_date_change FKs stable when title/date fields change.
    await reconcileServerOccurrences({
      source: 'radarr',
      sourceServerId: 1,
      occurrences: [occurrence()],
      ...window,
      result: emptySyncResult(),
      initialBackfill: true,
    });
    const existing = await getRepository(ReleaseOccurrence).findOneByOrFail({
      source: 'radarr',
      sourceServerId: 1,
      sourceItemId: 42,
      dateType: 'digital',
    });
    await getRepository(ReleaseDateChange).save(
      getRepository(ReleaseDateChange).create({
        occurrenceId: existing.id,
        oldStartsAt: null,
        newStartsAt: existing.startsAt,
        changeKind: 'announced',
        detectedAt: new Date('2026-08-02T00:00:00.000Z'),
        notifiable: true,
        metadata: '{"source":"radarr","dateType":"digital"}',
      })
    );

    const result = emptySyncResult();
    await reconcileServerOccurrences({
      source: 'radarr',
      sourceServerId: 1,
      occurrences: [
        {
          ...occurrence(),
          title: 'Changed again',
          rawDates: '{"digitalRelease":"2026-08-20","title":"Changed again"}',
        },
      ],
      ...window,
      result,
      initialBackfill: false,
    });

    const updated = await getRepository(ReleaseOccurrence).findOneByOrFail({
      id: existing.id,
    });
    assert.equal(updated.title, 'Changed again');
    assert.equal(await getRepository(ReleaseOccurrence).count(), 1);
    assert.equal(
      await getRepository(ReleaseDateChange).countBy({
        occurrenceId: existing.id,
      }),
      1
    );
    assert.equal(result.inserted, 0);
  });
});
