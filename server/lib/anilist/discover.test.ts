import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseAnilistListUrl, toWatchlistItems } from './discover';

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

describe('parseAnilistListUrl', () => {
  it('reads a single list from a profile list link', () => {
    assert.deepEqual(
      parseAnilistListUrl('https://anilist.co/user/Alice/animelist/Completed'),
      { userName: 'Alice', listName: 'Completed' }
    );
    assert.deepEqual(
      parseAnilistListUrl('anilist.co/user/Bob/animelist/Rewatch%20Club/'),
      { userName: 'Bob', listName: 'Rewatch Club' }
    );
  });

  it('reads a whole library from a profile or bare username', () => {
    assert.deepEqual(
      parseAnilistListUrl('https://www.anilist.co/user/Carol/animelist?x=1'),
      { userName: 'Carol' }
    );
    assert.deepEqual(parseAnilistListUrl('https://anilist.co/user/Dan'), {
      userName: 'Dan',
    });
    assert.deepEqual(parseAnilistListUrl('  Erin_99 '), {
      userName: 'Erin_99',
    });
  });

  it('rejects manga lists, other sites, and empty input', () => {
    assert.throws(
      () => parseAnilistListUrl('https://anilist.co/user/Alice/mangalist'),
      /only anime lists/
    );
    assert.throws(
      () => parseAnilistListUrl('https://trakt.tv/users/a/lists/b'),
      /Unsupported AniList list URL/
    );
    assert.throws(() => parseAnilistListUrl(''), /required/);
  });
});
