import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  JELLYFIN_STATUS_BATCH_CHUNK_SIZE,
  fetchJellyfinStatusChunks,
} from './jellyfin';

describe('Jellyfin media-action status batching', () => {
  it('keeps every request at the configured bound for 100 items', async () => {
    const calls: string[][] = [];
    const ids = Array.from({ length: 100 }, (_, index) => `item-${index}`);

    const result = await fetchJellyfinStatusChunks(ids, async (chunk) => {
      calls.push(chunk);
      return chunk;
    });

    assert.deepEqual(
      calls.map((chunk) => chunk.length),
      [JELLYFIN_STATUS_BATCH_CHUNK_SIZE, JELLYFIN_STATUS_BATCH_CHUNK_SIZE]
    );
    assert.equal(result.entries.length, 100);
    assert.deepEqual(result.failedIds, []);
  });

  it('isolates a failed chunk and de-duplicates item IDs', async () => {
    const calls: string[][] = [];
    const ids = [
      ...Array.from({ length: 50 }, (_, index) => `first-${index}`),
      ...Array.from({ length: 50 }, (_, index) => `second-${index}`),
      'first-0',
    ];

    const result = await fetchJellyfinStatusChunks(ids, async (chunk) => {
      calls.push(chunk);
      if (chunk[0] === 'first-0') throw new Error('temporary failure');
      return chunk;
    });

    assert.equal(calls.length, 2);
    assert.equal(result.failedIds.length, 50);
    assert.deepEqual(result.entries, calls[1]);
  });
});

describe('JellyfinMediaActionProvider.rate', () => {
  it('rejects direct rating writes instead of returning a successful empty status', async () => {
    const { JellyfinMediaActionProvider } = await import('./jellyfin');
    const provider = new JellyfinMediaActionProvider();
    await assert.rejects(
      () =>
        provider.rate(1, { mediaType: 'movie', tmdbId: 1 }, { ratingStars: 4 }),
      /does not support rating/
    );
  });
});
