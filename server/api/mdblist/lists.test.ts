import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  mapMdblistListItems,
  mapMdblistPublicLists,
  parseMdblistListRef,
} from './lists';

describe('parseMdblistListRef', () => {
  it('parses public list URLs', () => {
    assert.deepEqual(
      parseMdblistListRef(
        'https://mdblist.com/lists/linaspurinis/top-watched-movies-of-the-week'
      ),
      {
        kind: 'slug',
        username: 'linaspurinis',
        slug: 'top-watched-movies-of-the-week',
      }
    );
  });

  it('parses json list URLs and www hosts', () => {
    assert.deepEqual(
      parseMdblistListRef(
        'https://www.mdblist.com/lists/garycrawfordgc/latest-tv-shows/json/'
      ),
      {
        kind: 'slug',
        username: 'garycrawfordgc',
        slug: 'latest-tv-shows',
      }
    );
  });

  it('parses shorthand username/slug references', () => {
    assert.deepEqual(parseMdblistListRef('hdlists/horror'), {
      kind: 'slug',
      username: 'hdlists',
      slug: 'horror',
    });
  });

  it('parses numeric list ids', () => {
    assert.deepEqual(parseMdblistListRef('2194'), {
      kind: 'id',
      listId: 2194,
    });
  });

  it('rejects empty values', () => {
    assert.throws(
      () => parseMdblistListRef(''),
      /List URL or reference is required/
    );
  });

  it('rejects unsupported URLs', () => {
    assert.throws(
      () => parseMdblistListRef('https://trakt.tv/users/alice/lists/favorites'),
      /Unsupported MDBList list URL/
    );
  });
});

describe('mapMdblistListItems', () => {
  it('flattens movies and shows and maps TMDB ids', () => {
    const items = mapMdblistListItems({
      movies: [
        {
          id: 917496,
          rank: 2,
          title: 'Beetlejuice Beetlejuice',
          mediatype: 'movie',
          ids: { tmdb: 917496 },
        },
      ],
      shows: [
        {
          id: 1399,
          rank: 1,
          title: 'Game of Thrones',
          mediatype: 'show',
          ids: { tmdb: 1399 },
        },
      ],
    });

    assert.deepEqual(items, [
      {
        tmdbId: 1399,
        mediaType: 'tv',
        title: 'Game of Thrones',
        rank: 1,
      },
      {
        tmdbId: 917496,
        mediaType: 'movie',
        title: 'Beetlejuice Beetlejuice',
        rank: 2,
      },
    ]);
  });

  it('keeps items without a TMDB id when a title is present', () => {
    const items = mapMdblistListItems({
      movies: [
        {
          title: 'Unknown',
          mediatype: 'movie',
          ids: { imdb: 'tt1234567' },
        },
      ],
      shows: [{ id: 253941, title: 'The Paper', mediatype: 'show' }],
    });

    assert.deepEqual(items, [
      {
        tmdbId: 253941,
        mediaType: 'tv',
        title: 'The Paper',
        rank: undefined,
      },
      {
        mediaType: 'movie',
        title: 'Unknown',
        rank: undefined,
        imdbId: 'tt1234567',
      },
    ]);
  });
});

describe('mapMdblistPublicLists', () => {
  it('groups movie and show variants of the same slug', () => {
    const lists = mapMdblistPublicLists([
      {
        id: 1176,
        name: 'Latest Certified Fresh Releases',
        slug: 'latest-certified-fresh-releases',
        user_name: 'linaspurinis',
        mediatype: 'movie',
        items: 30,
        likes: 21,
      },
      {
        id: 6365,
        name: 'Latest Certified Fresh Releases',
        slug: 'latest-certified-fresh-releases',
        user_name: 'linaspurinis',
        mediatype: 'show',
        items: 30,
        likes: 18,
      },
    ]);

    assert.equal(lists.length, 1);
    assert.equal(lists[0].username, 'linaspurinis');
    assert.equal(lists[0].slug, 'latest-certified-fresh-releases');
    assert.equal(lists[0].itemCount, 60);
    assert.equal(lists[0].likes, 21);
  });
});
