import type {
  AnilistDiscoverItem,
  AnilistMedia,
} from '@server/api/anilist/interfaces';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mapAnilistMediaPage,
  parseAnilistListUrl,
  toWatchlistItems,
} from './discover';

describe('mapAnilistMediaPage', () => {
  // 95 entries: every 7th is dropped by mapping, every 5th shares a TMDB show
  // with the entry before it, so tiles and raw entries do not line up.
  const media = Array.from(
    { length: 95 },
    (_, n) => ({ id: n + 1, format: 'TV' }) as AnilistMedia
  );
  const fakeMap = (counter: number[]) => async (entry: AnilistMedia) => {
    counter.push(entry.id);
    if (entry.id % 7 === 0) return null;
    const tmdbId = entry.id % 5 === 0 ? 1000 + entry.id - 1 : 1000 + entry.id;
    return {
      anilistId: entry.id,
      tmdbId,
      mediaType: 'tv',
      title: `A${entry.id}`,
    } as AnilistDiscoverItem;
  };
  // What mapping the whole list and then paging gave.
  const reference = async (page: number) => {
    const all: AnilistDiscoverItem[] = [];
    const seen = new Set<string>();
    for (const entry of media) {
      const item = await fakeMap([])(entry);
      if (!item) continue;
      const keys = [`anilist:${item.anilistId}`, `tv:${item.tmdbId}`];
      if (keys.some((key) => seen.has(key))) continue;
      keys.forEach((key) => seen.add(key));
      all.push(item);
    }
    const start = (page - 1) * 20;
    return {
      page,
      results: all.slice(start, start + 20),
      hasMore: start + 20 < all.length,
    };
  };

  it('gives the same page as mapping the whole list', async () => {
    for (const page of [1, 2, 3, 4, 5, 6]) {
      assert.deepEqual(
        await mapAnilistMediaPage(media, page, { mapMedia: fakeMap([]) }),
        await reference(page),
        `page ${page}`
      );
    }
  });

  it('maps only as far as the page needs', async () => {
    const mapped: number[] = [];
    const first = await mapAnilistMediaPage(media, 1, {
      mapMedia: fakeMap(mapped),
    });
    assert.equal(first.results.length, 20);
    assert.equal(first.hasMore, true);
    assert.ok(mapped.length < 30, `mapped ${mapped.length} of 95`);
    assert.deepEqual(
      [...mapped].sort((a, b) => a - b),
      mapped.map((_, n) => n + 1),
      'a prefix of the list, each entry once'
    );
  });

  it('treats a bad page as the first', async () => {
    const page = await mapAnilistMediaPage(media, Number.NaN, {
      mapMedia: fakeMap([]),
    });
    assert.equal(page.page, 1);
    assert.deepEqual(page, await reference(1));
  });
});

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
