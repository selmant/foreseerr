import { groupSorts } from '@app/components/Discover/listSort';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  countMdblistFilters,
  defaultMdblistOrder,
  hasMdblistFilters,
  mdblistClearParams,
  mdblistSortOptions,
  mdblistSorts,
  prepareMdblistOptions,
  ratingToDisplay,
  ratingToQuery,
  releaseDatesForYears,
  yearOfDate,
} from './mdblistFilterOptions';

describe('MDBList list filters', () => {
  it('sends only the filters MDBList reads, trimmed', () => {
    assert.deepEqual(
      prepareMdblistOptions({
        url: 'https://mdblist.com/lists/a/b',
        page: '2',
        mediaType: 'tv',
        sort: 'imdbrating',
        order: 'desc',
        title: '  star ',
        genres: 'drama,anime-isekai',
        genreMode: 'and',
        imdbRatingMin: '70',
        malMax: '90',
        genre: '18',
        hideUnmapped: 'true',
      }),
      {
        mediaType: 'tv',
        sort: 'imdbrating',
        order: 'desc',
        title: 'star',
        genres: 'drama,anime-isekai',
        genreMode: 'and',
        imdbRatingMin: '70',
        malMax: '90',
        hideUnmapped: 'true',
      }
    );
  });

  it('drops the genre mode without genres', () => {
    assert.deepEqual(
      prepareMdblistOptions({ genreMode: 'and', title: ' ' }),
      {}
    );
  });

  it('counts panel filters, one per rating source and date range', () => {
    // The content type is in the panel now; the bar's search is not counted.
    assert.equal(
      countMdblistFilters({
        sort: 'score',
        mediaType: 'movie',
        genres: 'drama',
        genreMode: 'and',
        releasedFrom: '2020-01-01',
        releasedTo: '2024-01-01',
        scoreMin: '60',
        scoreMax: '90',
        letterboxdMin: '70',
        hideUnmapped: 'false',
        title: 'star',
      }),
      5
    );
    assert.ok(hasMdblistFilters({ title: 'star' }));
    assert.ok(!hasMdblistFilters({ sort: 'score', hideUnmapped: 'false' }));
  });

  it('orders names A→Z and everything else high→low by default', () => {
    assert.equal(defaultMdblistOrder('title'), 'asc');
    assert.equal(defaultMdblistOrder('rank'), 'asc');
    assert.equal(defaultMdblistOrder('imdbrating'), 'desc');
    assert.ok(!(mdblistSorts as readonly string[]).includes('random'));
  });

  it('groups the menu and drops duplicates and sorts that do not fit', () => {
    const values = (mediaType?: 'movie' | 'tv') =>
      groupSorts(mdblistSortOptions, { mediaType }).flatMap((g) =>
        g.options.map((o) => o.option.value)
      );
    assert.ok(!values().includes('rank'));
    assert.ok(!values().includes('usort'));
    assert.ok(!values().includes('sort_title'));
    assert.ok(values('tv').includes('last_air_date'));
    assert.ok(!values('tv').includes('budget'));
    assert.ok(!values('movie').includes('last_air_date'));
    assert.ok(values().length < mdblistSorts.length);
  });

  it("shows ratings on each source's own scale", () => {
    assert.equal(ratingToDisplay('imdbRating', 73), 7.3);
    assert.equal(ratingToQuery('imdbRating', 7.3), 73);
    assert.equal(ratingToDisplay('letterboxd', 92), 4.6);
    assert.equal(ratingToQuery('letterboxd', 3.7), 74);
    assert.equal(ratingToQuery('mal', 8.7), 87);
    assert.equal(ratingToDisplay('rtCritics', 88), 88);
    assert.equal(ratingToQuery('imdbRating', 10.04), 100);
  });

  it('reads and writes release years as whole-year dates', () => {
    assert.equal(yearOfDate('2020-06-15'), 2020);
    assert.equal(yearOfDate('soon'), undefined);
    assert.deepEqual(releaseDatesForYears(2001, 2010), {
      releasedFrom: '2001-01-01',
      releasedTo: '2010-12-31',
    });
  });

  it('clears the panel, and the search only from an empty result', () => {
    assert.equal(mdblistClearParams().hideUnmapped, 'false');
    assert.ok('mediaType' in mdblistClearParams());
    assert.ok(!('title' in mdblistClearParams()));
    assert.ok('title' in mdblistClearParams({ search: true }));
  });
});
