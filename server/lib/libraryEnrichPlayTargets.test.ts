import type JellyfinAPI from '@server/api/jellyfin';
import { enrichSeriesPlayTargets } from '@server/lib/library';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('enrichSeriesPlayTargets', () => {
  it('resolves a completed series with one episode-list request', async () => {
    let seasonsCalls = 0;
    let seriesEpisodeCalls = 0;
    const client = {
      getResumeItems: async () => {
        throw new Error('should use provided resume');
      },
      getNextUpEpisodes: async () => {
        throw new Error('should use provided next-up');
      },
      getSeasons: async () => {
        seasonsCalls += 1;
        return [{ Id: 'season-1' }];
      },
      getEpisodes: async () => {
        throw new Error('per-season fetch should not run');
      },
      getSeriesEpisodes: async () => {
        seriesEpisodeCalls += 1;
        return [
          {
            Id: 'ep-1',
            SeriesId: 'series-1',
            Type: 'Episode',
            ParentIndexNumber: 1,
            IndexNumber: 1,
            UserData: { Played: true },
          },
        ];
      },
    };

    const [title] = await enrichSeriesPlayTargets(
      client as unknown as JellyfinAPI,
      [
        {
          mediaType: 'tv',
          jellyfinItemId: 'series-1',
          title: 'Completed',
        },
      ],
      { resume: [], nextUp: [], resolveMissing: true }
    );

    assert.equal(seasonsCalls, 0);
    assert.equal(seriesEpisodeCalls, 1);
    assert.equal(title.playItemId, 'ep-1');
    assert.match(title.subtitle ?? '', /Rewatch/);
  });
});
