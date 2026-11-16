import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  countMdblistFilters,
  defaultMdblistOrder,
  mdblistSorts,
  prepareMdblistOptions,
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
      }),
      5
    );
  });

  it('orders names A→Z and everything else high→low by default', () => {
    assert.equal(defaultMdblistOrder('title'), 'asc');
    assert.equal(defaultMdblistOrder('rank'), 'asc');
    assert.equal(defaultMdblistOrder('imdbrating'), 'desc');
    assert.ok(!(mdblistSorts as readonly string[]).includes('random'));
  });
});
