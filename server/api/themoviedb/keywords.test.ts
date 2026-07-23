import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import { extractKeywordList } from '@server/api/themoviedb/keywords';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('extractKeywordList', () => {
  it('reads movie-style keywords.keywords', () => {
    assert.deepEqual(
      extractKeywordList({
        keywords: [{ id: ANIME_KEYWORD_ID, name: 'anime' }],
      }),
      [{ id: ANIME_KEYWORD_ID, name: 'anime' }]
    );
  });

  it('reads TV-style keywords.results', () => {
    assert.deepEqual(
      extractKeywordList({
        results: [{ id: ANIME_KEYWORD_ID, name: 'anime' }],
      }),
      [{ id: ANIME_KEYWORD_ID, name: 'anime' }]
    );
  });

  it('reads a bare keyword array', () => {
    assert.deepEqual(extractKeywordList([{ id: 1, name: 'x' }]), [
      { id: 1, name: 'x' },
    ]);
  });

  it('returns empty list for nullish or unknown shapes', () => {
    assert.deepEqual(extractKeywordList(null), []);
    assert.deepEqual(extractKeywordList(undefined), []);
    assert.deepEqual(extractKeywordList({}), []);
  });
});
