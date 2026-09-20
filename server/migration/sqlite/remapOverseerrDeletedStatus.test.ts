import { MediaStatus, MediaType } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import Season from '@server/entity/Season';
import { RemapOverseerrDeletedStatus1789257612345 } from '@server/migration/sqlite/1789254652493-RemapOverseerrDeletedStatus';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

setupTestDb();

describe('RemapOverseerrDeletedStatus', () => {
  it('rewrites leftover Overseerr DELETED=6 to DELETED=7 except real blocklist rows', async () => {
    const mediaRepository = getRepository(Media);
    const leftover = await mediaRepository.save(
      new Media({
        tmdbId: 91001,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.BLOCKLISTED,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const blocklisted = await mediaRepository.save(
      new Media({
        tmdbId: 91002,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.BLOCKLISTED,
        status4k: MediaStatus.BLOCKLISTED,
      })
    );
    const show = await mediaRepository.save(
      new Media({
        tmdbId: 91003,
        mediaType: MediaType.TV,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
        seasons: [
          new Season({
            seasonNumber: 1,
            status: MediaStatus.BLOCKLISTED,
            status4k: MediaStatus.BLOCKLISTED,
          }),
        ],
      })
    );

    await dataSource.query(
      `INSERT INTO "blocklist" ("mediaType", "tmdbId") VALUES (?, ?)`,
      [MediaType.MOVIE, blocklisted.tmdbId]
    );

    const migration = new RemapOverseerrDeletedStatus1789257612345();
    await dataSource.transaction((manager) =>
      migration.up(manager.queryRunner as never)
    );

    const remapped = await mediaRepository.findOneOrFail({
      where: { id: leftover.id },
    });
    const stillBlocked = await mediaRepository.findOneOrFail({
      where: { id: blocklisted.id },
    });
    const remappedShow = await mediaRepository.findOneOrFail({
      where: { id: show.id },
      relations: ['seasons'],
    });

    assert.equal(remapped.status, MediaStatus.DELETED);
    assert.equal(stillBlocked.status, MediaStatus.BLOCKLISTED);
    assert.equal(stillBlocked.status4k, MediaStatus.BLOCKLISTED);
    assert.equal(remappedShow.seasons[0].status, MediaStatus.DELETED);
    assert.equal(remappedShow.seasons[0].status4k, MediaStatus.DELETED);
  });
});
