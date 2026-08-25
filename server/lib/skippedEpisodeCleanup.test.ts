import type JellyfinAPI from '@server/api/jellyfin';
import type { JellyfinLibraryItemExtended } from '@server/api/jellyfin';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cleanupSkippedEpisodeEndings,
  type SkippedEpisodeCleanupDependencies,
} from './skippedEpisodeCleanup';

const item = (
  id: string,
  number: number,
  percentage: number
): JellyfinLibraryItemExtended =>
  ({
    Id: id,
    Name: id,
    Type: 'Episode',
    LocationType: 'FileSystem',
    HasSubtitles: false,
    MediaType: 'Video',
    ProviderIds: { Tmdb: `episode-${id}` },
    SeriesId: 'series',
    ParentIndexNumber: 1,
    IndexNumber: number,
    UserData: { PlayedPercentage: percentage },
  }) as JellyfinLibraryItemExtended;

const seriesEpisode = (
  id: string,
  number: number,
  percentage: number
): JellyfinLibraryItemExtended => item(id, number, percentage);

const client = {} as JellyfinAPI;

function dependencies(
  overrides: Partial<SkippedEpisodeCleanupDependencies> = {}
) {
  const calls = { traktWrites: [] as number[], jellyfinWrites: [] as string[] };
  const deps: SkippedEpisodeCleanupDependencies = {
    providersAvailable: async () => true,
    loadSeriesEpisodes: async () => [item('e1', 1, 75), item('e2', 2, 10)],
    loadMappedTmdbIds: async () => new Map([['series', 123]]),
    loadSeriesItem: async () => undefined,
    getTraktSeasonStatus: async () => ({
      available: true,
      watchedEpisodeNumbers: [],
    }),
    setTraktWatched: async (_user, _show, _season, episode) => {
      calls.traktWrites.push(episode);
      return true;
    },
    removeTraktPlayback: async () => undefined,
    markJellyfinPlayed: async (_client, _user, episodeId) => {
      calls.jellyfinWrites.push(episodeId);
    },
    ...overrides,
  };
  return { calls, deps };
}

describe('skipped episode cleanup orchestration', () => {
  it('does nothing when providers are unavailable', async () => {
    let hydrated = false;
    const { deps } = dependencies({
      providersAvailable: async () => false,
      loadSeriesEpisodes: async () => {
        hydrated = true;
        return [];
      },
    });
    const resume = [item('e1', 1, 75)];
    assert.equal(
      await cleanupSkippedEpisodeEndings(7, client, resume, deps),
      resume
    );
    assert.equal(hydrated, false);
  });

  it('writes Trakt before Jellyfin and removes only a full success', async () => {
    const order: string[] = [];
    const { deps } = dependencies({
      setTraktWatched: async () => {
        order.push('trakt');
        return true;
      },
      markJellyfinPlayed: async () => {
        order.push('jellyfin');
      },
    });
    const e1 = item('e1', 1, 75);
    const e2 = item('e2', 2, 10);
    assert.deepEqual(
      await cleanupSkippedEpisodeEndings(7, client, [e1, e2], deps),
      [e2]
    );
    assert.deepEqual(order, ['trakt', 'jellyfin']);
  });

  it('skips history insertion when Trakt already has the episode', async () => {
    const { calls, deps } = dependencies({
      getTraktSeasonStatus: async () => ({
        available: true,
        watchedEpisodeNumbers: [1],
      }),
    });
    await cleanupSkippedEpisodeEndings(7, client, [item('e1', 1, 75)], deps);
    assert.deepEqual(calls.traktWrites, []);
    assert.deepEqual(calls.jellyfinWrites, ['e1']);
  });

  it('retains the episode when mapping, Trakt, or Jellyfin fails', async () => {
    const e1 = item('e1', 1, 75);
    const missing = dependencies({ loadMappedTmdbIds: async () => new Map() });
    assert.deepEqual(
      await cleanupSkippedEpisodeEndings(7, client, [e1], missing.deps),
      [e1]
    );

    const traktFailure = dependencies({ setTraktWatched: async () => false });
    assert.deepEqual(
      await cleanupSkippedEpisodeEndings(7, client, [e1], traktFailure.deps),
      [e1]
    );
    assert.deepEqual(traktFailure.calls.jellyfinWrites, []);

    const jellyfinFailure = dependencies({
      markJellyfinPlayed: async () => {
        throw new Error('no');
      },
    });
    assert.deepEqual(
      await cleanupSkippedEpisodeEndings(7, client, [e1], jellyfinFailure.deps),
      [e1]
    );
  });

  it('never uses the episode provider id as the Trakt show id', async () => {
    let showId: number | undefined;
    const { deps } = dependencies({
      loadMappedTmdbIds: async () => new Map(),
      loadSeriesItem: async () => ({
        ...item('series', 1, 0),
        Type: 'Series',
        ProviderIds: { Tmdb: '456' },
      }),
      getTraktSeasonStatus: async (_user, tmdbId) => {
        showId = tmdbId;
        return { available: true, watchedEpisodeNumbers: [1] };
      },
    });
    await cleanupSkippedEpisodeEndings(7, client, [item('e1', 1, 75)], deps);
    assert.equal(showId, 456);
  });

  it('falls back to the Jellyfin series when the media mapping query fails', async () => {
    let showId: number | undefined;
    const { deps } = dependencies({
      loadMappedTmdbIds: async () => {
        throw new Error('database unavailable');
      },
      loadSeriesItem: async () => ({
        ...item('series', 1, 0),
        Type: 'Series',
        ProviderIds: { TheMovieDb: '789' },
      }),
      getTraktSeasonStatus: async (_user, tmdbId) => {
        showId = tmdbId;
        return { available: true, watchedEpisodeNumbers: [1] };
      },
    });
    await cleanupSkippedEpisodeEndings(7, client, [item('e1', 1, 75)], deps);
    assert.equal(showId, 789);
  });

  it('marks older stale endings but keeps the leading in-progress episode', async () => {
    const writes: string[] = [];
    const e10 = seriesEpisode('e10', 10, 70);
    const e12 = seriesEpisode('e12', 12, 65);
    const e13 = seriesEpisode('e13', 13, 60);
    const e15 = seriesEpisode('e15', 15, 55);
    const { deps } = dependencies({
      loadSeriesEpisodes: async () => [e10, e12, e13, e15],
      markJellyfinPlayed: async (_client, _user, episodeId) => {
        writes.push(episodeId);
      },
    });
    const resume = [e10, e12, e13, e15];
    assert.deepEqual(
      await cleanupSkippedEpisodeEndings(7, client, resume, deps),
      [e15]
    );
    assert.deepEqual(writes.sort(), ['e10', 'e12', 'e13']);
  });

  it('clears leftover resume ticks on episodes already marked played', async () => {
    const playbackClears: number[] = [];
    const e1 = {
      ...item('e1', 1, 88),
      UserData: { Played: true, PlayedPercentage: 88 },
    };
    const e2 = item('e2', 2, 10);
    const { calls, deps } = dependencies({
      loadSeriesEpisodes: async () => [e1, e2],
      getTraktSeasonStatus: async () => ({
        available: true,
        watchedEpisodeNumbers: [1],
      }),
      removeTraktPlayback: async (_user, _show, _season, episode) => {
        playbackClears.push(episode);
      },
    });
    assert.deepEqual(
      await cleanupSkippedEpisodeEndings(7, client, [e1, e2], deps),
      [e2]
    );
    assert.deepEqual(calls.traktWrites, []);
    assert.deepEqual(playbackClears, [1]);
    assert.deepEqual(calls.jellyfinWrites, ['e1']);
  });
});
