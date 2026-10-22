import type { PlexMetadata } from '@server/api/plexapi';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { plexFullScanner } from '@server/lib/scanners/plex';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

setupTestDb();

// The scanner's private movie path, reached without a library run
const scanner = plexFullScanner as unknown as {
  enable4kMovie: boolean;
  processPlexMovieByTmdbId(item: PlexMetadata, tmdbId: number): Promise<void>;
};

after(() => {
  scanner.enable4kMovie = false;
});

function fakePlexMovie(ratingKey: string, resolutions: string[]): PlexMetadata {
  return {
    ratingKey,
    guid: `plex://movie/${ratingKey}`,
    type: 'movie',
    title: 'Test Movie',
    Guid: [],
    index: 0,
    leafCount: 0,
    viewedLeafCount: 0,
    addedAt: 1_700_000_000,
    updatedAt: 0,
    Media: resolutions.map((videoResolution, i) => ({
      id: i,
      duration: 6000,
      bitrate: 4000,
      width: videoResolution === '4k' ? 3840 : 1920,
      height: videoResolution === '4k' ? 2160 : 1080,
      aspectRatio: 1.78,
      audioChannels: 2,
      audioCodec: 'aac',
      videoCodec: 'h264',
      videoResolution,
      container: 'mkv',
      videoFrameRate: '24p',
      videoProfile: 'high',
    })),
  };
}

describe('Plex Scanner', () => {
  describe('movie versions', () => {
    it('should save a movie with both a 1080p and a 4K version as both', async () => {
      scanner.enable4kMovie = true;

      await scanner.processPlexMovieByTmdbId(
        fakePlexMovie('plex-mixed-rk', ['1080', '4k']),
        603
      );

      const media = await getRepository(Media).findOneOrFail({
        where: { tmdbId: 603, mediaType: MediaType.MOVIE },
      });
      assert.strictEqual(media.status, MediaStatus.AVAILABLE);
      assert.strictEqual(media.status4k, MediaStatus.AVAILABLE);
      assert.strictEqual(media.ratingKey, 'plex-mixed-rk');
      assert.strictEqual(media.ratingKey4k, 'plex-mixed-rk');
    });

    it('should save a 4K-only movie as 4K only', async () => {
      scanner.enable4kMovie = true;

      await scanner.processPlexMovieByTmdbId(
        fakePlexMovie('plex-uhd-rk', ['4k']),
        604
      );

      const media = await getRepository(Media).findOneOrFail({
        where: { tmdbId: 604, mediaType: MediaType.MOVIE },
      });
      assert.strictEqual(media.status, MediaStatus.UNKNOWN);
      assert.strictEqual(media.status4k, MediaStatus.AVAILABLE);
      assert.strictEqual(media.ratingKey, null);
      assert.strictEqual(media.ratingKey4k, 'plex-uhd-rk');
    });

    it('should save a 4K version as standard without a 4K Radarr', async () => {
      scanner.enable4kMovie = false;

      await scanner.processPlexMovieByTmdbId(
        fakePlexMovie('plex-no4k-rk', ['1080', '4k']),
        605
      );

      const media = await getRepository(Media).findOneOrFail({
        where: { tmdbId: 605, mediaType: MediaType.MOVIE },
      });
      assert.strictEqual(media.status, MediaStatus.AVAILABLE);
      assert.strictEqual(media.status4k, MediaStatus.UNKNOWN);
      assert.strictEqual(media.ratingKey, 'plex-no4k-rk');
      assert.strictEqual(media.ratingKey4k, null);
    });
  });
});
