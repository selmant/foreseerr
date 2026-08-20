import { MediaStatus } from '@server/constants/media';
import Season from '@server/entity/Season';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nextSeasonStatus, rollupShowStatus } from './seasonStatus';

describe('season availability transitions', () => {
  it('keeps an existing available season stable and handles per-quality processing', () => {
    assert.equal(
      nextSeasonStatus({
        previous: MediaStatus.AVAILABLE,
        totalEpisodes: 10,
        availableEpisodes: 0,
        canBeAvailable: true,
        processingForQuality: true,
        processing: true,
      }),
      MediaStatus.AVAILABLE
    );
    assert.equal(
      nextSeasonStatus({
        previous: MediaStatus.PROCESSING,
        totalEpisodes: 10,
        availableEpisodes: 0,
        canBeAvailable: true,
        processingForQuality: true,
        processing: false,
      }),
      MediaStatus.UNKNOWN
    );
  });

  it('rolls only real seasons with known source data into title availability', () => {
    const seasons = [
      new Season({ seasonNumber: 0, status: MediaStatus.AVAILABLE }),
      new Season({ seasonNumber: 1, status: MediaStatus.AVAILABLE }),
      new Season({ seasonNumber: 2, status: MediaStatus.UNKNOWN }),
    ];
    assert.equal(
      rollupShowStatus({
        seasons,
        scannedSeasons: [
          {
            seasonNumber: 1,
            totalEpisodes: 10,
            episodes: 10,
            episodes4k: 0,
          },
          {
            seasonNumber: 2,
            totalEpisodes: 0,
            episodes: 0,
            episodes4k: 0,
          },
        ],
        statusKey: 'status',
        previous: MediaStatus.UNKNOWN,
        enabled: true,
      }),
      MediaStatus.AVAILABLE
    );
  });
});
