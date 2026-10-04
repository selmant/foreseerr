/* eslint-disable no-relative-import-paths/no-relative-import-paths */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  libraryBrowseApiPath,
  mergeBrowsePatch,
  serializeBrowseApiQuery,
  serializeBrowseState,
} from '../../src/components/Library/browseUrlState';

const base = {
  sort: 'dateAdded' as const,
  order: 'desc' as const,
  take: 24,
  skip: 0,
  density: 'compact' as const,
};

describe('serializeBrowseState', () => {
  it('keeps compact density on the page URL', () => {
    const params = serializeBrowseState(base);
    assert.equal(params.get('density'), 'compact');
  });
});

describe('mergeBrowsePatch', () => {
  it('keeps a typed search when applying mediaType or watched chips', () => {
    const next = mergeBrowsePatch(
      { ...base, q: undefined },
      { mediaType: 'movie', watched: 'unwatched' },
      '  dune  '
    );
    assert.equal(next.q, 'dune');
    assert.equal(next.mediaType, 'movie');
    assert.equal(next.watched, 'unwatched');
    assert.equal(next.skip, 0);
  });

  it('lets an explicit search patch win over the pending input', () => {
    const next = mergeBrowsePatch(base, { q: 'other' }, 'dune');
    assert.equal(next.q, 'other');
  });

  it('drops q when the pending search is empty', () => {
    const next = mergeBrowsePatch(
      { ...base, q: 'dune' },
      { mediaType: 'tv' },
      '  '
    );
    assert.equal(next.q, undefined);
    assert.equal(next.mediaType, 'tv');
  });
});

describe('serializeBrowseApiQuery', () => {
  it('omits density so OpenAPI request validation does not 400', () => {
    const params = serializeBrowseApiQuery(base);
    assert.equal(params.get('density'), null);
    assert.equal(params.toString().includes('density'), false);
  });

  it('encodes spaces for OpenAPI without losing genres or pagination', () => {
    const path = libraryBrowseApiPath({
      ...base,
      q: 'World Trigger',
      genre: ['Action & Adventure', 'Sci-Fi + Fantasy'],
      skip: 24,
    });
    assert.ok(path.includes('q=World%20Trigger'));
    assert.ok(path.includes('genre=Action%20%26%20Adventure'));
    assert.ok(path.includes('genre=Sci-Fi%20%2B%20Fantasy'));
    const params = new URL(path, 'http://localhost').searchParams;
    assert.deepEqual(params.getAll('genre'), [
      'Action & Adventure',
      'Sci-Fi + Fantasy',
    ]);
    assert.equal(params.get('skip'), '24');
    assert.equal(params.get('density'), null);
  });
});
