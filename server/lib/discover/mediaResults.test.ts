import { MediaType } from '@server/constants/media';
import type Media from '@server/entity/Media';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findRelatedMedia, indexRelatedMedia } from './mediaResults';

describe('Discover related media lookup', () => {
  it('keeps movie and TV entries with the same TMDB id separate', () => {
    const movie = { tmdbId: 42, mediaType: MediaType.MOVIE } as Media;
    const tv = { tmdbId: 42, mediaType: MediaType.TV } as Media;
    const index = indexRelatedMedia([movie, tv]);

    assert.equal(findRelatedMedia(index, 42, MediaType.MOVIE), movie);
    assert.equal(findRelatedMedia(index, 42, MediaType.TV), tv);
  });
});
