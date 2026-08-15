import { expandTmdbGenreIds } from '@server/lib/tmdbGenreEquivalents';
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
  });

  it('leaves shared IDs unchanged', () => {
    assert.deepEqual(expandTmdbGenreIds([18, 35]), [18, 35]);
  });

  it('drops non-finite values', () => {
    assert.deepEqual(expandTmdbGenreIds([Number.NaN, 16]), [16]);
  });
});
