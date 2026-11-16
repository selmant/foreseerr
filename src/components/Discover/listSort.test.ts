import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ListSortOption } from './listSort';
import {
  defaultOrderForKind,
  directionMessageKey,
  groupSorts,
  sortAvailability,
  sortDroppedByMediaType,
} from './listSort';

const options: ListSortOption<string>[] = [
  { value: 'added', kind: 'date', group: 'list' },
  { value: 'dup', kind: 'position', group: 'list', hidden: true },
  { value: 'imdb', kind: 'number', group: 'ratings', vip: true },
  { value: 'budget', kind: 'number', group: 'details', only: 'movie' },
  { value: 'airdate', kind: 'date', group: 'release', only: 'tv' },
  { value: 'mine', kind: 'number', group: 'activity', personal: true },
];

describe('list sort menus', () => {
  it('groups sorts in menu order and drops hidden ones', () => {
    assert.deepEqual(
      groupSorts(options).map((g) => [
        g.group,
        g.options.map((o) => o.option.value),
      ]),
      [
        ['list', ['added']],
        ['release', ['airdate']],
        ['ratings', ['imdb']],
        ['details', ['budget']],
        ['activity', ['mine']],
      ]
    );
  });

  it('leaves out sorts that do not apply to the content type', () => {
    const tv = groupSorts(options, { mediaType: 'tv' }).flatMap((g) =>
      g.options.map((o) => o.option.value)
    );
    assert.ok(tv.includes('airdate'));
    assert.ok(!tv.includes('budget'));
  });

  it('marks VIP sorts only when the account is known not to be VIP', () => {
    const imdb = options[2];
    assert.equal(sortAvailability(imdb, { vip: null }), 'available');
    assert.equal(sortAvailability(imdb, { vip: true }), 'available');
    assert.equal(sortAvailability(imdb, { vip: false }), 'needsVip');
  });

  it('hides personal sorts without a linked account', () => {
    assert.equal(sortAvailability(options[5], { linked: false }), null);
    assert.equal(sortAvailability(options[5], {}), 'available');
  });

  it('words the direction for what the sort orders by', () => {
    assert.equal(directionMessageKey('position', 'asc'), 'topFirst');
    assert.equal(directionMessageKey('alpha', 'desc'), 'zToA');
    assert.equal(directionMessageKey('date', 'desc'), 'newestFirst');
    assert.equal(directionMessageKey('number', 'asc'), 'lowestFirst');
    assert.equal(defaultOrderForKind('alpha'), 'asc');
    assert.equal(defaultOrderForKind('date'), 'desc');
  });

  it('drops a movie-only sort when the list switches to shows', () => {
    assert.ok(sortDroppedByMediaType(options, 'budget', 'tv'));
    assert.ok(!sortDroppedByMediaType(options, 'budget', 'movie'));
    assert.ok(!sortDroppedByMediaType(options, 'budget', undefined));
    assert.ok(!sortDroppedByMediaType(options, 'imdb', 'tv'));
  });
});
