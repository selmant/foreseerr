import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseInterventionState, updateInterventionSearch } from './queryState';

describe('intervention queue navigation', () => {
  it('restores the shared history view, filters, and page', () => {
    assert.deepEqual(
      parseInterventionState(
        '?mode=history&serviceType=sonarr&mediaType=tv&page=3'
      ),
      {
        mode: 'history',
        serviceType: 'sonarr',
        mediaType: 'tv',
        page: 2,
      }
    );
  });
  it('ignores unsupported filters and unsafe page values', () => {
    for (const page of ['-2', '1.5', 'Infinity', '9007199254740992']) {
      assert.deepEqual(
        parseInterventionState(
          `?mode=all&serviceType=other&mediaType=series&page=${page}`
        ),
        {
          mode: 'active',
          serviceType: '',
          mediaType: '',
          page: 0,
        }
      );
    }
  });
  it('returns to the first page when changing filters and preserves unrelated parameters', () => {
    const params = updateInterventionSearch(
      '?mode=history&serviceType=sonarr&page=4&from=sidebar',
      { mediaType: 'tv' }
    );
    assert.deepEqual(parseInterventionState(params.toString()), {
      mode: 'history',
      serviceType: 'sonarr',
      mediaType: 'tv',
      page: 0,
    });
    assert.equal(params.get('from'), 'sidebar');
    assert.equal(params.has('page'), false);
  });
  it('preserves the review scope during pagination and clears filters together', () => {
    const next = updateInterventionSearch(
      '?mode=history&serviceType=radarr&mediaType=movie',
      { page: 1 }
    );
    assert.equal(next.get('page'), '2');
    assert.equal(next.get('serviceType'), 'radarr');
    const cleared = updateInterventionSearch(next.toString(), {
      serviceType: '',
      mediaType: '',
    });
    assert.equal(cleared.toString(), 'mode=history');
  });
});
