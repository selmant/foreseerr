import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// eslint-disable-next-line no-relative-import-paths/no-relative-import-paths
import { writeSucceeded } from '../../../src/utils/mediaActions';

const provider = (ok: boolean) => ({
  provider: 'trakt',
  ok,
  watched: ok,
  rating: null,
  ratingStars: null,
});

describe('client media-action write outcome handling', () => {
  it('accepts full and partial writes with an applied provider', () => {
    assert.equal(
      writeSucceeded({
        outcome: 'success',
        watched: true,
        providers: [provider(true)],
      }),
      true
    );
    assert.equal(
      writeSucceeded({
        outcome: 'partial',
        watched: true,
        providers: [
          provider(false),
          { ...provider(true), provider: 'jellyfin' },
        ],
      }),
      true
    );
  });

  it('rejects total failures and empty provider results', () => {
    assert.equal(
      writeSucceeded({
        outcome: 'failure',
        watched: false,
        providers: [provider(false)],
      }),
      false
    );
    assert.equal(
      writeSucceeded({ outcome: 'success', watched: true, providers: [] }),
      false
    );
  });
});
