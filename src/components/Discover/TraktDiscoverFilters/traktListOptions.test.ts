import { groupSorts } from '@app/components/Discover/listSort';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  countTraktFilters,
  defaultTraktSortHow,
  isWatchlistUrl,
  traktClearParams,
  traktListSortOptions,
} from './traktListOptions';

const menu = (context: Parameters<typeof groupSorts>[1]) =>
  groupSorts(traktListSortOptions, context).flatMap((g) =>
    g.options.map((o) => [o.option.value, o.availability])
  );

describe('Trakt list sorts', () => {
  it('disables VIP sorts only for accounts known not to have VIP', () => {
    assert.ok(
      menu({ vip: false }).some(
        ([value, state]) => value === 'imdb_rating' && state === 'needsVip'
      )
    );
    assert.ok(
      menu({ vip: null }).some(
        ([value, state]) => value === 'imdb_rating' && state === 'available'
      )
    );
  });

  it('hides personal sorts without a linked account', () => {
    assert.ok(!menu({ linked: false }).some(([v]) => v === 'my_rating'));
    assert.ok(menu({ linked: true }).some(([v]) => v === 'my_rating'));
  });

  it('keeps the backend defaults for the direction', () => {
    assert.equal(defaultTraktSortHow('rank'), 'asc');
    assert.equal(defaultTraktSortHow('title'), 'asc');
    assert.equal(defaultTraktSortHow('added'), 'desc');
    assert.equal(defaultTraktSortHow('imdb_rating'), 'desc');
  });

  it('recognises watchlist links', () => {
    assert.ok(isWatchlistUrl('https://trakt.tv/users/me/watchlist'));
    assert.ok(!isWatchlistUrl('https://trakt.tv/users/me/lists/favs'));
  });
});

describe('Trakt filter count', () => {
  it('does not count the explicit false that Clear writes', () => {
    const cleared = {
      ignoreWatched: 'false',
      hideUnmapped: 'false',
    } as const;
    assert.equal(countTraktFilters(cleared), 0);
    assert.equal(
      countTraktFilters({ ignoreWatched: 'true', hideUnmapped: 'true' }),
      2
    );
    assert.equal(
      countTraktFilters({ ignoreWatched: 'true' }, { showHideWatched: false }),
      0
    );
  });

  it('clears every filter and keeps saved defaults off', () => {
    const params: Record<string, string | undefined> = traktClearParams({
      genre: '18',
      ignoreWatched: 'true',
    });
    assert.equal(params.genre, undefined);
    assert.equal(params.ignoreWatched, 'false');
    assert.equal(params.hideUnmapped, 'false');
  });
});
