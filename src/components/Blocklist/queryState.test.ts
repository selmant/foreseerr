import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { blocklistPath, parseBlocklistQuery } from './queryState';

describe('Blocklist browse state', () => {
  it('shows all sources by default and ignores invalid paging', () => {
    assert.deepEqual(
      parseBlocklistQuery('?filter=unknown&page=-2&pageSize=500'),
      {
        filter: 'all',
        q: '',
        page: 1,
        pageSize: 10,
      }
    );
    assert.equal(parseBlocklistQuery('?page=1.5').page, 1);
  });

  it('keeps source, search, page, and page size in a shareable URL', () => {
    const state = {
      filter: 'blocklistedTags' as const,
      q: 'Action & Adventure + sci-fi',
      page: 3,
      pageSize: 25,
    };
    assert.deepEqual(
      parseBlocklistQuery(
        new URL(blocklistPath(state), 'http://localhost').search
      ),
      state
    );
  });

  it('omits defaults and trims empty searches', () => {
    assert.equal(
      blocklistPath({ filter: 'all', q: '  ', page: 1, pageSize: 10 }),
      '/blocklist'
    );
  });
});
