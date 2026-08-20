import {
  ANILIST_MEDIA_ACTION_CAPABILITIES,
  JELLYFIN_MEDIA_ACTION_CAPABILITIES,
  TRAKT_MEDIA_ACTION_CAPABILITIES,
  getDefaultMediaActionProviders,
  getMediaActionCapabilities,
  type MediaActionProvider,
} from '@server/lib/mediaActions';
import { anilistEpisodeActions } from '@server/lib/mediaActions/anilistEpisodes';
import { jellyfinEpisodeActions } from '@server/lib/mediaActions/jellyfin';
import { traktEpisodeActions } from '@server/lib/mediaActions/traktEpisodes';
import { setupTestDb } from '@server/test/db';
import {
  createMediaActionsTestApp,
  loginAsAdmin,
} from '@server/test/mediaActionsTestUtils';
import type { Express } from 'express';
import assert from 'node:assert/strict';
import { before, beforeEach, describe, it, mock } from 'node:test';
import request from 'supertest';

let app: Express;

const traktAvailableMock = mock.method(
  getDefaultMediaActionProviders()[0],
  'isAvailable',
  async () => true
);
const jellyfinAvailableMock = mock.method(
  getDefaultMediaActionProviders()[1],
  'isAvailable',
  async () => false
);
const traktEpisodeAvailableMock = mock.method(
  traktEpisodeActions,
  'isAvailable',
  async () => true
);
const jellyfinEpisodeAvailableMock = mock.method(
  jellyfinEpisodeActions,
  'isAvailable',
  async () => false
);
const anilistAvailableMock = mock.method(
  getDefaultMediaActionProviders()[2],
  'isAvailable',
  async () => false
);
const anilistEpisodeAvailableMock = mock.method(
  anilistEpisodeActions,
  'isAvailable',
  async () => false
);

before(() => {
  app = createMediaActionsTestApp();
});

setupTestDb();

describe('media-actions capabilities', () => {
  beforeEach(() => {
    traktAvailableMock.mock.mockImplementation(async () => true);
    jellyfinAvailableMock.mock.mockImplementation(async () => false);
    anilistAvailableMock.mock.mockImplementation(async () => false);
    traktEpisodeAvailableMock.mock.mockImplementation(async () => true);
    jellyfinEpisodeAvailableMock.mock.mockImplementation(async () => false);
    anilistEpisodeAvailableMock.mock.mockImplementation(async () => false);
  });

  it('requires an authenticated user', async () => {
    const res = await request(app).get('/api/v1/media-actions/capabilities');
    assert.equal(res.status, 401);
  });

  it('reports Trakt-only capabilities', async () => {
    const agent = await loginAsAdmin(app);
    const res = await agent.get('/api/v1/media-actions/capabilities');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.movie, { watched: true, rating: true });
    assert.deepEqual(res.body.tv, { watched: true, rating: true });
    assert.deepEqual(res.body.episode, { watched: true, rating: false });
    assert.equal(res.body.providers.length, 3);
    assert.deepEqual(res.body.providers[0], {
      id: 'trakt',
      linked: true,
      capabilities: TRAKT_MEDIA_ACTION_CAPABILITIES,
    });
    assert.deepEqual(res.body.providers[1], {
      id: 'jellyfin',
      linked: false,
      capabilities: JELLYFIN_MEDIA_ACTION_CAPABILITIES,
    });
    assert.deepEqual(res.body.providers[2], {
      id: 'anilist',
      linked: false,
      capabilities: ANILIST_MEDIA_ACTION_CAPABILITIES,
    });
  });

  it('reports Jellyfin-only capabilities', async () => {
    traktAvailableMock.mock.mockImplementation(async () => false);
    jellyfinAvailableMock.mock.mockImplementation(async () => true);
    traktEpisodeAvailableMock.mock.mockImplementation(async () => false);
    jellyfinEpisodeAvailableMock.mock.mockImplementation(async () => true);
    const agent = await loginAsAdmin(app);

    const res = await agent.get('/api/v1/media-actions/capabilities');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.movie, { watched: true, rating: false });
    assert.deepEqual(res.body.tv, { watched: true, rating: false });
    assert.deepEqual(res.body.episode, { watched: true, rating: false });
    assert.equal(res.body.providers[0].linked, false);
    assert.equal(res.body.providers[1].linked, true);
  });

  it('reports both-provider capabilities', async () => {
    jellyfinAvailableMock.mock.mockImplementation(async () => true);
    jellyfinEpisodeAvailableMock.mock.mockImplementation(async () => true);
    const agent = await loginAsAdmin(app);

    const res = await agent.get('/api/v1/media-actions/capabilities');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.movie, { watched: true, rating: true });
    assert.deepEqual(res.body.episode, { watched: true, rating: false });
    assert.equal(res.body.providers[0].linked, true);
    assert.equal(res.body.providers[1].linked, true);
  });

  it('reports neither-provider capabilities', async () => {
    traktAvailableMock.mock.mockImplementation(async () => false);
    jellyfinAvailableMock.mock.mockImplementation(async () => false);
    traktEpisodeAvailableMock.mock.mockImplementation(async () => false);
    jellyfinEpisodeAvailableMock.mock.mockImplementation(async () => false);
    const agent = await loginAsAdmin(app);

    const res = await agent.get('/api/v1/media-actions/capabilities');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.movie, { watched: false, rating: false });
    assert.deepEqual(res.body.tv, { watched: false, rating: false });
    assert.deepEqual(res.body.episode, { watched: false, rating: false });
  });
});

describe('getMediaActionCapabilities unit matrix', () => {
  it('derives surface flags from provider capability support', async () => {
    const providers: MediaActionProvider[] = [
      {
        id: 'trakt',
        capabilities: TRAKT_MEDIA_ACTION_CAPABILITIES,
        isAvailable: async () => false,
        getStatus: async () => ({
          watched: false,
          rating: null,
          ratingStars: null,
        }),
        getStatuses: async () => [],
        markWatched: async () => ({
          watched: true,
          rating: null,
          ratingStars: null,
        }),
        unmarkWatched: async () => ({
          watched: false,
          rating: null,
          ratingStars: null,
        }),
        rate: async () => ({ watched: false, rating: 8, ratingStars: 4 }),
      },
      {
        id: 'jellyfin',
        capabilities: JELLYFIN_MEDIA_ACTION_CAPABILITIES,
        isAvailable: async () => true,
        getStatus: async () => ({
          watched: false,
          rating: null,
          ratingStars: null,
        }),
        getStatuses: async () => [],
        markWatched: async () => ({
          watched: true,
          rating: null,
          ratingStars: null,
        }),
        unmarkWatched: async () => ({
          watched: false,
          rating: null,
          ratingStars: null,
        }),
        rate: async () => ({
          watched: false,
          rating: null,
          ratingStars: null,
        }),
      },
    ];

    traktEpisodeAvailableMock.mock.mockImplementation(async () => false);
    jellyfinEpisodeAvailableMock.mock.mockImplementation(async () => true);
    anilistEpisodeAvailableMock.mock.mockImplementation(async () => false);

    const capabilities = await getMediaActionCapabilities(1, providers);

    assert.deepEqual(capabilities.movie, { watched: true, rating: false });
    assert.deepEqual(capabilities.episode, { watched: true, rating: false });
  });
});
