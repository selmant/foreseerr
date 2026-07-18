import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MediaActionDispatcher } from './dispatcher';
import type {
  MediaActionProvider,
  MediaActionStatus,
  MediaItemRef,
} from './types';

const item: MediaItemRef = { mediaType: 'movie', tmdbId: 550 };

function stubStatus(
  overrides: Partial<MediaActionStatus> = {}
): MediaActionStatus {
  return {
    watched: false,
    rating: null,
    ratingStars: null,
    ...overrides,
  };
}

function makeProvider(
  id: 'trakt',
  overrides: Partial<MediaActionProvider> & {
    available?: boolean;
    fail?: boolean;
  } = {}
): MediaActionProvider {
  const available = overrides.available ?? true;
  const fail = overrides.fail ?? false;

  return {
    id,
    isAvailable: async () => available,
    getStatus: async () => {
      if (fail) throw new Error(`${id} failed`);
      return stubStatus({ watched: true, rating: 8, ratingStars: 4 });
    },
    getStatuses: async (_userId, items) =>
      items.map((i) => ({
        ...i,
        ...stubStatus({ watched: true, rating: 8, ratingStars: 4 }),
      })),
    markWatched: async () => {
      if (fail) throw new Error(`${id} mark failed`);
      return stubStatus({ watched: true, rating: null, ratingStars: null });
    },
    unmarkWatched: async () =>
      stubStatus({ watched: false, rating: null, ratingStars: null }),
    rate: async () => stubStatus({ watched: true, rating: 10, ratingStars: 5 }),
    ...overrides,
  };
}

describe('MediaActionDispatcher', () => {
  it('fans out markWatched to all available providers', async () => {
    const calls: string[] = [];
    const trakt = makeProvider('trakt', {
      markWatched: async () => {
        calls.push('trakt');
        return stubStatus({ watched: true });
      },
    });

    const dispatcher = new MediaActionDispatcher([trakt]);
    const result = await dispatcher.markWatched(1, item);

    assert.deepEqual(calls, ['trakt']);
    assert.equal(result.watched, true);
    assert.equal(result.providers.length, 1);
    assert.equal(result.providers[0].ok, true);
    assert.equal(result.providers[0].provider, 'trakt');
  });

  it('skips unavailable providers', async () => {
    const trakt = makeProvider('trakt', { available: false });
    const dispatcher = new MediaActionDispatcher([trakt]);
    const result = await dispatcher.markWatched(1, item);

    assert.equal(result.providers.length, 0);
    assert.equal(result.watched, false);
  });

  it('records partial failure without throwing', async () => {
    const trakt = makeProvider('trakt', { fail: true });
    const dispatcher = new MediaActionDispatcher([trakt]);
    const result = await dispatcher.markWatched(1, item);

    assert.equal(result.providers[0].ok, false);
    assert.match(result.providers[0].error ?? '', /mark failed/);
    assert.equal(result.watched, false);
  });

  it('aggregates batch status from providers', async () => {
    const trakt = makeProvider('trakt');
    const dispatcher = new MediaActionDispatcher([trakt]);
    const results = await dispatcher.getStatuses(1, [
      item,
      { mediaType: 'tv', tmdbId: 1399 },
    ]);

    assert.equal(results.length, 2);
    assert.equal(results[0].watched, true);
    assert.equal(results[0].ratingStars, 4);
    assert.equal(results[1].mediaType, 'tv');
  });
});
