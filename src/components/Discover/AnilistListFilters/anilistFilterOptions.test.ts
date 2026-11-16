import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  anilistYearRange,
  countAnilistFilters,
  defaultAnilistOrder,
  prepareAnilistOptions,
} from './anilistFilterOptions';

describe('AniList list filters', () => {
  it('sends only the filters the list routes read', () => {
    assert.deepEqual(
      prepareAnilistOptions({
        name: 'Favourites',
        page: '3',
        search: ' frieren ',
        format: 'TV,MOVIE',
        genres: 'Drama',
        yearFrom: '2020',
        sort: 'score',
        order: 'desc',
        genre: '18',
        hideUnmapped: 'true',
      }),
      {
        search: 'frieren',
        format: 'TV,MOVIE',
        genres: 'Drama',
        yearFrom: '2020',
        sort: 'score',
        order: 'desc',
        hideUnmapped: 'true',
      }
    );
  });

  it('counts each range once and leaves the sort out', () => {
    assert.equal(
      countAnilistFilters({
        sort: 'title',
        search: 'a',
        country: 'JP',
        yearFrom: '2000',
        yearTo: '2010',
        averageScoreMin: '70',
        myScoreMax: '90',
      }),
      5
    );
  });

  it('orders titles A→Z and the rest high→low', () => {
    assert.equal(defaultAnilistOrder('title'), 'asc');
    assert.equal(defaultAnilistOrder('updatedAt'), 'desc');
    assert.deepEqual(anilistYearRange(new Date('2026-11-05')), {
      min: 1940,
      max: 2027,
    });
  });
});
