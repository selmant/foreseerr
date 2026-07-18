import TraktAPI from '@server/api/trakt';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('TraktAPI.parseListUrl', () => {
  it('parses user list URLs', () => {
    assert.deepEqual(
      TraktAPI.parseListUrl('https://trakt.tv/users/alice/lists/favorites'),
      { username: 'alice', listRef: 'favorites' }
    );
  });

  it('parses watchlist URLs', () => {
    assert.deepEqual(
      TraktAPI.parseListUrl('https://trakt.tv/users/bob/watchlist'),
      { username: 'bob', listRef: 'watchlist' }
    );
  });

  it('parses global list URLs', () => {
    assert.deepEqual(TraktAPI.parseListUrl('https://trakt.tv/lists/12345'), {
      username: null,
      listRef: '12345',
    });
  });

  it('parses shorthand user/slug references', () => {
    assert.deepEqual(TraktAPI.parseListUrl('carol/top-movies'), {
      username: 'carol',
      listRef: 'top-movies',
    });
  });

  it('parses bare numeric list ids', () => {
    assert.deepEqual(TraktAPI.parseListUrl('999'), {
      username: null,
      listRef: '999',
    });
  });

  it('rejects empty values', () => {
    assert.throws(
      () => TraktAPI.parseListUrl(''),
      /List URL or reference is required/
    );
  });

  it('rejects unsupported URLs', () => {
    assert.throws(
      () => TraktAPI.parseListUrl('https://trakt.tv/movies/tron'),
      /Unsupported Trakt list URL/
    );
  });
});
