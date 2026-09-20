import TheMovieDb from '@server/api/themoviedb';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  annotateProviderActiveRequests,
  findRelatedMedia,
  getRelatedMediaIndex,
  indexRelatedMedia,
} from './mediaResults';

setupTestDb();

beforeEach(() => {
  Object.defineProperty(TheMovieDb.prototype, 'get', {
    configurable: true,
    value: async (endpoint: string) => {
      const movieMatch = /^\/movie\/(\d+)/.exec(endpoint);
      if (movieMatch) {
        return {
          id: Number(movieMatch[1]),
          title: 'Test Movie',
          original_language: 'en',
          genres: [],
          keywords: { keywords: [] },
          external_ids: {},
        };
      }
      throw new Error(`Unexpected TMDB endpoint ${endpoint}`);
    },
  });
});

afterEach(() => {
  delete (TheMovieDb.prototype as { get?: unknown }).get;
});

describe('Discover related media lookup', () => {
  it('keeps movie and TV entries with the same TMDB id separate', () => {
    const movie = { tmdbId: 42, mediaType: MediaType.MOVIE } as Media;
    const tv = { tmdbId: 42, mediaType: MediaType.TV } as Media;
    const index = indexRelatedMedia([movie, tv]);

    assert.equal(findRelatedMedia(index, 42, MediaType.MOVIE), movie);
    assert.equal(findRelatedMedia(index, 42, MediaType.TV), tv);
  });

  it('marks only active requests for the matching media type', async () => {
    const original = getSettings().main.hideRequested;
    getSettings().main = { ...getSettings().main, hideRequested: true };
    try {
      const user = await getRepository(User).findOneByOrFail({
        email: 'admin@seerr.dev',
      });
      const mediaRepository = getRepository(Media);
      const movie = await mediaRepository.save(
        new Media({
          tmdbId: 987651,
          mediaType: MediaType.MOVIE,
          status: MediaStatus.PENDING,
        })
      );
      await mediaRepository.save(
        new Media({
          tmdbId: 987651,
          mediaType: MediaType.TV,
          status: MediaStatus.UNKNOWN,
        })
      );
      const requestRepository = getRepository(MediaRequest);
      const request = await requestRepository.save(
        new MediaRequest({
          type: MediaType.MOVIE,
          media: movie,
          requestedBy: user,
          status: MediaRequestStatus.PENDING,
          is4k: false,
          seasons: [],
          episodes: [],
        })
      );

      const index = await getRelatedMediaIndex(user, [
        { tmdbId: 987651, mediaType: MediaType.MOVIE },
        { tmdbId: 987651, mediaType: MediaType.TV },
      ]);
      assert.equal(
        findRelatedMedia(index, 987651, MediaType.MOVIE)?.hasActiveRequest,
        true
      );
      assert.equal(
        findRelatedMedia(index, 987651, MediaType.TV)?.hasActiveRequest,
        false
      );

      const tiles = await annotateProviderActiveRequests([
        {
          id: 1,
          tmdbId: 987651,
          mediaType: 'movie' as const,
          title: 'Movie',
          ratingKey: 'm',
        },
        {
          id: 2,
          tmdbId: 987651,
          mediaType: 'tv' as const,
          title: 'TV',
          ratingKey: 't',
        },
        { id: 3, title: 'Unmapped', ratingKey: 'u' },
      ]);
      assert.deepEqual(
        tiles.map((item) => item.hasActiveRequest),
        [true, undefined, undefined]
      );

      request.status = MediaRequestStatus.APPROVED;
      await requestRepository.save(request);
      assert.equal(
        findRelatedMedia(
          await getRelatedMediaIndex(user, [
            { tmdbId: 987651, mediaType: MediaType.MOVIE },
          ]),
          987651,
          MediaType.MOVIE
        )?.hasActiveRequest,
        true
      );

      request.status = MediaRequestStatus.DECLINED;
      await requestRepository.save(request);
      assert.equal(
        findRelatedMedia(
          await getRelatedMediaIndex(user, [
            { tmdbId: 987651, mediaType: MediaType.MOVIE },
          ]),
          987651,
          MediaType.MOVIE
        )?.hasActiveRequest,
        false
      );
    } finally {
      getSettings().main = { ...getSettings().main, hideRequested: original };
    }
  });
});
