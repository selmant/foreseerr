import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hasBrowseQueryFilters,
  needsMdblistBrowseFilters,
  needsTmdbBrowseFilters,
  needsTraktRatingBrowseFilters,
  parseBrowseQueryFilters,
} from './query';

describe('parseBrowseQueryFilters', () => {
  it('returns empty filters when no FilterSlideover params are set', () => {
    const filters = parseBrowseQueryFilters({});
    assert.equal(hasBrowseQueryFilters(filters), false);
    assert.equal(filters.voteAverageGte, null);
    assert.deepEqual(filters.genreIds, []);
    assert.equal(filters.includeNoRating, true);
  });

  it('parses shared FilterSlideover query params including MDBList rating ranges', () => {
    const filters = parseBrowseQueryFilters({
      voteAverageGte: '7',
      voteCountGte: '100',
      genre: '28,35',
      language: 'en',
      primaryReleaseDateGte: '2020-01-01',
      withRuntimeGte: '90',
      withRuntimeLte: '120',
      status: '3|4',
      imdbRatingGte: '7.5',
      imdbRatingLte: '9',
      rtCriticsGte: '80',
      rtCriticsLte: '95',
      metacriticGte: '70',
      traktRatingGte: '8',
      traktRatingLte: '10',
      includeNoRating: 'false',
    });
    assert.equal(hasBrowseQueryFilters(filters), true);
    assert.equal(needsMdblistBrowseFilters(filters), true);
    assert.equal(needsTmdbBrowseFilters(filters), true);
    assert.equal(needsTraktRatingBrowseFilters(filters), true);
    assert.equal(filters.voteAverageGte, 7);
    assert.equal(filters.voteCountGte, 100);
    assert.deepEqual(filters.genreIds, [28, 35]);
    assert.equal(filters.language, 'en');
    assert.equal(filters.releaseDateGte, '2020-01-01');
    assert.equal(filters.runtimeGte, 90);
    assert.equal(filters.runtimeLte, 120);
    assert.deepEqual(filters.seriesStatusIds, [3, 4]);
    assert.equal(filters.imdbRatingGte, 7.5);
    assert.equal(filters.imdbRatingLte, 9);
    assert.equal(filters.rtCriticsGte, 80);
    assert.equal(filters.rtCriticsLte, 95);
    assert.equal(filters.metacriticGte, 70);
    assert.equal(filters.traktRatingGte, 8);
    assert.equal(filters.traktRatingLte, 10);
    assert.equal(filters.includeNoRating, false);
  });

  it('detects trakt-only vs tmdb-only browse gates', () => {
    const traktOnly = parseBrowseQueryFilters({ traktRatingGte: '7' });
    assert.equal(needsTraktRatingBrowseFilters(traktOnly), true);
    assert.equal(needsTmdbBrowseFilters(traktOnly), false);
    assert.equal(needsMdblistBrowseFilters(traktOnly), true);

    const tmdbOnly = parseBrowseQueryFilters({ voteAverageGte: '7' });
    assert.equal(needsTmdbBrowseFilters(tmdbOnly), true);
    assert.equal(needsMdblistBrowseFilters(tmdbOnly), false);
  });
});
