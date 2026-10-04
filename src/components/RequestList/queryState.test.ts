import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRequestListState, requestListPath } from './queryState';

describe('request list navigation', () => {
  it('restores validated preferences, including media type', () => {
    const state = parseRequestListState('', {
      currentFilter: 'all',
      currentMediaType: 'tv',
      currentSort: 'modified',
      currentSortDirection: 'asc',
      currentPageSize: 25,
    });
    assert.deepEqual(state, {
      filter: 'all',
      mediaType: 'tv',
      sort: 'modified',
      sortDirection: 'asc',
      pageSize: 25,
      page: 1,
    });
  });
  it('rejects invalid URL values and malformed preference fields', () => {
    const state = parseRequestListState(
      '?filter=unknown&page=-2&pageSize=999&sortDirection=sideways',
      { currentFilter: 'all', currentSort: 42, currentMediaType: 'bad' }
    );
    assert.deepEqual(state, {
      filter: 'pending',
      mediaType: 'all',
      sort: 'added',
      sortDirection: 'desc',
      pageSize: 10,
      page: 1,
    });
    assert.equal(parseRequestListState('?page=1.5', null).page, 1);
  });
  it('round trips a shared page regardless of newer saved preferences', () => {
    const initial = parseRequestListState('?filter=all&mediaType=movie&page=3');
    const path = requestListPath(
      '/requests',
      initial,
      '?filter=all&mediaType=movie&page=3&userId=7'
    );
    assert.equal(
      new URL(path, 'http://localhost').searchParams.get('userId'),
      '7'
    );
    assert.deepEqual(
      parseRequestListState(path.split('?')[1], {
        currentFilter: 'failed',
        currentMediaType: 'tv',
        currentPageSize: 100,
      }),
      initial
    );
  });
  it('retains a profile route and unrelated parameters when returning to page one', () => {
    const path = requestListPath(
      '/users/7/requests',
      parseRequestListState('?filter=completed'),
      '?page=9&userId=7'
    );
    assert.equal(path.startsWith('/users/7/requests?'), true);
    assert.equal(
      new URL(path, 'http://localhost').searchParams.has('page'),
      false
    );
  });
});
