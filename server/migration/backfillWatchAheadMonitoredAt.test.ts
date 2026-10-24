import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import EpisodeRequest from '@server/entity/EpisodeRequest';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { BackfillWatchAheadMonitoredAt1789700000000 } from '@server/migration/sqlite/1789700000000-BackfillWatchAheadMonitoredAt';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

setupTestDb();

describe('BackfillWatchAheadMonitoredAt', () => {
  const createRequest = async (
    tmdbId: number,
    episodeSelectionType: 'watchAhead' | 'after'
  ) => {
    const user = await getRepository(User).findOneOrFail({
      where: { email: 'admin@seerr.dev' },
    });
    const media = await getRepository(Media).save(
      new Media({
        tmdbId,
        mediaType: MediaType.TV,
        status: MediaStatus.PROCESSING,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    return getRepository(MediaRequest).save(
      new MediaRequest({
        media,
        requestedBy: user,
        type: MediaType.TV,
        status: MediaRequestStatus.APPROVED,
        is4k: false,
        seasons: [],
        episodeSelectionType,
        watchAheadCount: 2,
        tvQuotaUnits: 1,
        episodes: [1, 2].map(
          (episodeNumber) =>
            new EpisodeRequest({
              tvdbId: tmdbId * 10 + episodeNumber,
              seasonNumber: 1,
              episodeNumber,
              status: MediaRequestStatus.APPROVED,
            })
        ),
      })
    );
  };

  const children = (requestId: number) =>
    getRepository(EpisodeRequest).find({
      where: { request: { id: requestId } },
      order: { episodeNumber: 'ASC' },
    });

  it('dates watch-ahead children from when they were added and keeps real dates', async () => {
    const watchAhead = await createRequest(92001, 'watchAhead');
    const ongoing = await createRequest(92002, 'after');
    const [first, second] = await children(watchAhead.id);
    const monitoredAt = new Date('2026-10-20T10:00:00Z');
    await getRepository(EpisodeRequest).update(second.id, { monitoredAt });

    const migration = new BackfillWatchAheadMonitoredAt1789700000000();
    await dataSource.transaction((manager) =>
      migration.up(manager.queryRunner as never)
    );

    const [backfilled, kept] = await children(watchAhead.id);
    assert.equal(
      backfilled.monitoredAt?.getTime(),
      first.createdAt.getTime(),
      'backfilled from createdAt'
    );
    assert.equal(kept.monitoredAt?.getTime(), monitoredAt.getTime());
    for (const child of await children(ongoing.id)) {
      assert.equal(child.monitoredAt ?? null, null, 'only watch-ahead');
    }
  });
});
