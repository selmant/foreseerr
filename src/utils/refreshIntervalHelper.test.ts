import { MediaType } from '@server/constants/media';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getRequestDownloadStatus } from './refreshIntervalHelper';

const download = (
  id: string,
  seasonNumber?: number,
  episodeNumber?: number
): DownloadingItem => ({
  mediaType: MediaType.TV,
  externalId: 1,
  size: 1000,
  sizeLeft: 500,
  status: 'downloading',
  timeLeft: '00:05:00',
  estimatedCompletionTime: new Date('2026-01-01T00:00:00Z'),
  title: 'Test Show',
  downloadId: id,
  ...(seasonNumber !== undefined && episodeNumber !== undefined
    ? {
        episode: {
          id: 1,
          seasonNumber,
          episodeNumber,
          absoluteEpisodeNumber: episodeNumber,
        },
      }
    : {}),
});

describe('getRequestDownloadStatus', () => {
  const s1e1 = download('s1e1', 1, 1);
  const s1e2 = download('s1e2', 1, 2);
  const s2e1 = download('s2e1', 2, 1);
  const noEpisode = download('unknown');

  it('movies retain all downloads and undefined status is empty', () => {
    assert.deepEqual(getRequestDownloadStatus([noEpisode], { type: 'movie' }), [
      noEpisode,
    ]);
    assert.deepEqual(
      getRequestDownloadStatus(undefined, { type: 'movie' }),
      []
    );
  });

  it('full season requests show only episodes from requested seasons', () => {
    assert.deepEqual(
      getRequestDownloadStatus([s1e1, s2e1, noEpisode], {
        type: 'tv',
        seasons: [{ seasonNumber: 2 }],
        episodes: [],
      }),
      [s2e1]
    );
  });

  it('episode requests show exact requested episodes', () => {
    assert.deepEqual(
      getRequestDownloadStatus([s1e1, s1e2, s2e1, noEpisode], {
        type: 'tv',
        seasons: [],
        episodes: [{ seasonNumber: 1, episodeNumber: 2 }],
      }),
      [s1e2]
    );
  });

  it('empty TV selections show no unrelated download', () => {
    assert.deepEqual(
      getRequestDownloadStatus([s1e1, noEpisode], {
        type: 'tv',
        seasons: [],
        episodes: [],
      }),
      []
    );
  });
});
