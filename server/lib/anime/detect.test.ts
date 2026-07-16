import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ANIMATION_GENRE_ID, isAnimeMedia } from './detect';

describe('isAnimeMedia', () => {
  it('detects Japanese animation as anime', () => {
    assert.equal(
      isAnimeMedia({
        genres: [{ id: ANIMATION_GENRE_ID }, { id: 10759 }],
        original_language: 'ja',
        origin_country: ['JP'],
      }),
      true
    );
  });

  it('does not treat non-Japanese animation as anime', () => {
    assert.equal(
      isAnimeMedia({
        genres: [{ id: ANIMATION_GENRE_ID }, { id: 35 }],
        original_language: 'en',
        origin_country: ['US'],
      }),
      false
    );
  });

  it('detects anime keyword metadata by name', () => {
    assert.equal(
      isAnimeMedia({
        genres: [{ id: 18 }],
        original_language: 'en',
        keywords: [{ id: 1, name: 'anime' }],
      }),
      true
    );
  });

  it('detects Seerr anime keyword id', () => {
    assert.equal(
      isAnimeMedia({
        genres: [{ id: 18 }],
        keywords: { results: [{ id: ANIME_KEYWORD_ID, name: 'anime' }] },
      }),
      true
    );
  });

  it('detects Animation + Japan origin without Japanese language', () => {
    assert.equal(
      isAnimeMedia({
        genres: [ANIMATION_GENRE_ID],
        original_language: 'en',
        production_countries: [{ iso_3166_1: 'JP' }],
      }),
      true
    );
  });

  it('reads movie-style keywords.keywords shape', () => {
    assert.equal(
      isAnimeMedia({
        keywords: { keywords: [{ id: ANIME_KEYWORD_ID, name: 'anime' }] },
      }),
      true
    );
  });
});
