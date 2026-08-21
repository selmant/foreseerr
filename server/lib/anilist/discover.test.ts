import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toWatchlistItems } from './discover';

describe('toWatchlistItems', () => {
  it('includes source identity and AniList URL for mapped and unmapped titles', () => {
    const items = toWatchlistItems([
      {
        anilistId: 21,
        tmdbId: 1402,
        mediaType: 'tv',
        title: 'The Walking Dead',
      },
      {
        anilistId: 99,
        mediaType: 'tv',
        title: 'Unmapped Anime',
        image: 'https://example.com/cover.png',
      },
    ]);

    assert.deepEqual(items[0], {
      id: 1402,
      ratingKey: 'anilist-21',
      tmdbId: 1402,
      mediaType: 'tv',
      title: 'The Walking Dead',
      source: 'anilist',
      sourceId: '21',
      sourceUrl: 'https://anilist.co/anime/21',
    });
    assert.equal(items[1].tmdbId, undefined);
    assert.equal(items[1].id, 99);
    assert.equal(items[1].sourceUrl, 'https://anilist.co/anime/99');
    assert.equal(items[1].image, 'https://example.com/cover.png');
  });
});
