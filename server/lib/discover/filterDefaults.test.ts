import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyDiscoverFilterDefaultsToQuery,
  parseDiscoverFilterDefaults,
  resolveIgnoreWatchedFromDefaults,
  safeParseDiscoverFilterDefaults,
} from './filterDefaults';

describe('discover filter defaults', () => {
  it('parses valid defaults and rejects unknown keys', () => {
    const parsed = parseDiscoverFilterDefaults({
      ignoreWatched: true,
      voteAverageGte: '7',
      genre: '28,18',
    });
    assert.equal(parsed.ignoreWatched, true);
    assert.equal(parsed.voteAverageGte, '7');
    assert.equal(parsed.genre, '28,18');

    assert.throws(() =>
      parseDiscoverFilterDefaults({ ignoreWatched: true, sortBy: 'popularity' })
    );
  });

  it('safeParse returns empty object for invalid JSON shapes', () => {
    assert.deepEqual(
      safeParseDiscoverFilterDefaults({ ignoreWatched: 'yes' }),
      {}
    );
    assert.deepEqual(safeParseDiscoverFilterDefaults(null), {});
  });

  it('applyDiscoverFilterDefaultsToQuery: query wins over defaults', () => {
    const merged = applyDiscoverFilterDefaultsToQuery<Record<string, unknown>>(
      { ignoreWatched: 'false', genre: '35' },
      { ignoreWatched: true, genre: '28', language: 'en' }
    );
    assert.equal(merged.ignoreWatched, 'false');
    assert.equal(merged.genre, '35');
    assert.equal(merged.language, 'en');
  });

  it('applyDiscoverFilterDefaultsToQuery: fills omitted keys from defaults', () => {
    const merged = applyDiscoverFilterDefaultsToQuery<Record<string, unknown>>(
      { page: '1' },
      {
        ignoreWatched: true,
        includeNoRating: false,
        voteAverageGte: '7.0',
      }
    );
    assert.equal(merged.ignoreWatched, 'true');
    assert.equal(merged.includeNoRating, 'false');
    assert.equal(merged.voteAverageGte, '7.0');
    assert.equal(merged.page, '1');
  });

  it('resolveIgnoreWatchedFromDefaults: query > default > false', () => {
    assert.equal(
      resolveIgnoreWatchedFromDefaults({ ignoreWatched: true }, 'false'),
      false
    );
    assert.equal(
      resolveIgnoreWatchedFromDefaults({ ignoreWatched: true }, false),
      false
    );
    assert.equal(
      resolveIgnoreWatchedFromDefaults({ ignoreWatched: true }, undefined),
      true
    );
    assert.equal(resolveIgnoreWatchedFromDefaults({}, undefined), false);
    assert.equal(
      resolveIgnoreWatchedFromDefaults({ ignoreWatched: false }, undefined),
      false
    );
  });
});
