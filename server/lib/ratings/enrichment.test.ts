import MdblistAPI, {
  getMdblistMetrics,
  resetMdblistMetrics,
} from '@server/api/mdblist';
import {
  clearMdblistProviderState,
  enrichResultsWithRatings,
  needsMdblistEnrichment,
} from '@server/lib/ratings';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';

setupTestDb();

const sampleResults = [
  {
    id: 1,
    mediaType: 'movie' as const,
    title: 'Test Movie',
    releaseDate: '2024-01-01',
  },
];

describe('needsMdblistEnrichment', () => {
  beforeEach(() => {
    const settings = getSettings();
    settings.mdblist = {
      apiKey: 'secret-key',
      showTmdb: true,
      showImdb: true,
      showRt: true,
      showRtUser: true,
      showMetacritic: true,
      showTraktCommunity: true,
      posterTmdb: true,
      posterImdb: true,
      posterRt: true,
      posterRtUser: false,
      posterMetacritic: false,
      posterTraktCommunity: false,
    };
  });

  it('returns false when no API key is configured', () => {
    getSettings().mdblist.apiKey = '';
    assert.equal(needsMdblistEnrichment(), false);
  });

  it('returns false when all MDBList-backed badges are disabled', () => {
    Object.assign(getSettings().mdblist, {
      showImdb: false,
      showRt: false,
      showRtUser: false,
      showMetacritic: false,
      showTraktCommunity: false,
    });
    assert.equal(needsMdblistEnrichment(), false);
  });

  it('returns true when browse filters require MDBList ratings', () => {
    Object.assign(getSettings().mdblist, {
      showImdb: false,
      showRt: false,
      showRtUser: false,
      showMetacritic: false,
      showTraktCommunity: false,
    });
    assert.equal(needsMdblistEnrichment({ imdbRatingGte: '7' }), true);
  });
});

describe('enrichResultsWithRatings gating', () => {
  beforeEach(() => {
    MdblistAPI.resetInstance();
    resetMdblistMetrics();
    const settings = getSettings();
    settings.mdblist = {
      apiKey: 'secret-key',
      showTmdb: true,
      showImdb: false,
      showRt: false,
      showRtUser: false,
      showMetacritic: false,
      showTraktCommunity: false,
      posterTmdb: true,
      posterImdb: false,
      posterRt: false,
      posterRtUser: false,
      posterMetacritic: false,
      posterTraktCommunity: false,
    };
  });

  it('skips MDBList calls when badges and filters do not require enrichment', async () => {
    const batchMock = mock.method(
      MdblistAPI.prototype,
      'getBatchRatings',
      async () => new Map()
    );

    const enriched = await enrichResultsWithRatings(sampleResults);

    assert.deepEqual(enriched, sampleResults);
    assert.equal(batchMock.mock.calls.length, 0);
    assert.equal(getMdblistMetrics().batchFetches, 0);

    batchMock.mock.restore();
  });

  it('enriches when browse filters require MDBList ratings', async () => {
    Object.assign(getSettings().mdblist, {
      showImdb: false,
      showRt: false,
      showRtUser: false,
      showMetacritic: false,
      showTraktCommunity: false,
    });

    const batchMock = mock.method(
      MdblistAPI.prototype,
      'getBatchRatings',
      async () =>
        new Map([
          [
            1,
            {
              imdbRating: 8.1,
            },
          ],
        ])
    );

    const enriched = await enrichResultsWithRatings(sampleResults, {
      query: { imdbRatingGte: '7' },
    });

    assert.equal(batchMock.mock.calls.length, 1);
    assert.equal(
      (enriched[0] as { ratings?: { imdb?: { criticsScore?: number } } })
        ?.ratings?.imdb?.criticsScore,
      8.1
    );

    batchMock.mock.restore();
  });
});

describe('clearMdblistProviderState', () => {
  it('resets the shared client after credential changes', async () => {
    getSettings().mdblist.apiKey = 'first-key';
    const first = MdblistAPI.getInstance();
    getSettings().mdblist.apiKey = 'second-key';
    clearMdblistProviderState();
    const second = MdblistAPI.getInstance();
    assert.notEqual(first, second);
  });
});
