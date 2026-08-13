/* eslint-disable no-relative-import-paths/no-relative-import-paths */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
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

describe('serializeBrowseApiQuery', () => {
  it('omits density so OpenAPI request validation does not 400', () => {
    const params = serializeBrowseApiQuery(base);
    assert.equal(params.get('density'), null);
    assert.equal(params.toString().includes('density'), false);
  });
});
