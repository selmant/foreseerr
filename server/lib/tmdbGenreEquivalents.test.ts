import {
  expandTmdbGenreIds,
  toTmdbDiscoverGenres,
} from '@server/lib/tmdbGenreEquivalents';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('expandTmdbGenreIds', () => {
  it('keeps exact IDs and adds the movie/TV pair', () => {
    assert.deepEqual(
      expandTmdbGenreIds([28]).sort((a, b) => a - b),
      [28, 10759]
    );
    assert.deepEqual(
      expandTmdbGenreIds([10759]).sort((a, b) => a - b),
      [12, 28, 10759]
    );
    assert.deepEqual(
      expandTmdbGenreIds([878]).sort((a, b) => a - b),
      [878, 10765]
    );
    assert.deepEqual(
      expandTmdbGenreIds([10751]).sort((a, b) => a - b),
      [10751, 10762]
    );
  });

  it('leaves shared IDs unchanged', () => {
    assert.deepEqual(expandTmdbGenreIds([18, 35]), [18, 35]);
  });

  it('drops non-finite values', () => {
    assert.deepEqual(expandTmdbGenreIds([Number.NaN, 16]), [16]);
  });
});

describe('toTmdbDiscoverGenres', () => {
  it('drops TV-only IDs from movie Discover after mapping equivalents', () => {
    assert.equal(toTmdbDiscoverGenres('28,10759', 'movie'), '28,28|12');
  });

  it('maps Kids onto Family for movie Discover', () => {
    assert.equal(toTmdbDiscoverGenres('10762', 'movie'), '10751');
  });

  it('preserves AND between distinct movie genres', () => {
    assert.equal(toTmdbDiscoverGenres('28,35', 'movie'), '28,35');
  });

  it('maps movie Action onto Action & Adventure for TV Discover', () => {
    assert.equal(toTmdbDiscoverGenres('28', 'tv'), '10759');
  });
});
