import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { discoverDefaultsEqual } from './filterState';

describe('Discover preference changes', () => {
  it('treats reordered settings and genre selections as the same preferences', () => {
    assert.equal(
      discoverDefaultsEqual(
        { genre: '10765,28,16', language: 'ja', ignoreWatched: true },
        { ignoreWatched: true, language: 'ja', genre: '16,28,10765,28' }
      ),
      true
    );
  });

  it('ignores empty optional fields but preserves explicit boolean overrides', () => {
    assert.equal(
      discoverDefaultsEqual({}, { language: '', genre: undefined }),
      true
    );
    assert.equal(discoverDefaultsEqual({}, { ignoreWatched: false }), false);
    assert.equal(discoverDefaultsEqual({}, { includeNoRating: false }), false);
  });

  it('detects changes to visibility, genres, dates, and rating limits', () => {
    const saved = {
      ignoreWatched: true,
      genre: '28,16',
      primaryReleaseDateGte: '2020-01-01',
      imdbRatingGte: '7',
    };
    for (const patch of [
      { ignoreWatched: false },
      { genre: '28' },
      { primaryReleaseDateGte: '2021-01-01' },
      { imdbRatingGte: '8' },
    ]) {
      assert.equal(discoverDefaultsEqual(saved, { ...saved, ...patch }), false);
    }
  });
});
