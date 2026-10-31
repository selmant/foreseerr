import { MediaType } from '@shared/constants/media';
import type { DownloadingItem } from '@shared/lib/downloadtracker';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createIntl } from 'react-intl';
import { downloadLabel, downloadScope, groupDownloads } from './downloadGroups';

const intl = createIntl({ locale: 'en' });

const item = (
  downloadId: string,
  seasonNumber?: number,
  episodeNumber?: number,
  extra: Partial<DownloadingItem> = {}
): DownloadingItem => ({
  mediaType: MediaType.TV,
  externalId: 7,
  size: 100,
  sizeLeft: 50,
  status: 'downloading',
  timeLeft: '00:10:00',
  estimatedCompletionTime: new Date(0),
  title: `Release ${downloadId}`,
  downloadId,
  ...(seasonNumber !== undefined && episodeNumber !== undefined
    ? {
        episode: {
          id: seasonNumber * 100 + episodeNumber,
          seasonNumber,
          episodeNumber,
          absoluteEpisodeNumber: 0,
        },
      }
    : {}),
  ...extra,
});

/** A Sonarr 5 pack as the tracker lists it: once per episode. */
const pack = (
  downloadId: string,
  seasons: [number, number][],
  isFullSeason: boolean
) => {
  const grouping = {
    seasons: seasons.map(([seasonNumber, episodeCount]) => ({
      seasonNumber,
      episodeCount,
      episodesWithFilesCount: 0,
    })),
    isFullSeason,
    episodesWithFilesCount: 0,
  };
  return seasons.flatMap(([seasonNumber, count]) =>
    Array.from({ length: count }, (_, i) =>
      item(downloadId, seasonNumber, i + 1, grouping)
    )
  );
};

describe('download groups', () => {
  it('keeps one entry per download, in tracker order', () => {
    const items = [
      item('a', 1, 2),
      item('b', 2, 1),
      item('a', 1, 3),
      item('', 3, 1),
      item('', 3, 2),
    ];
    const groups = groupDownloads(items);
    assert.deepEqual(
      groups.map((group) => group.items.length),
      [2, 1, 1, 1],
      'items without a download id stay apart'
    );
    assert.equal(groups[0].item, items[0]);
    assert.deepEqual(groupDownloads(undefined), []);
  });

  it('labels a Sonarr 5 season pack with its episode count', () => {
    assert.equal(
      downloadLabel(intl, pack('p', [[2, 10]], true)),
      'S02 pack (10 eps)'
    );
    assert.equal(
      downloadLabel(
        intl,
        pack(
          'p',
          [
            [1, 7],
            [2, 13],
          ],
          true
        )
      ),
      'S01–S02 pack (20 eps)'
    );
    // A request for season 2 only sees its own items, still of the pack.
    assert.equal(
      downloadLabel(
        intl,
        pack(
          'p',
          [
            [1, 7],
            [3, 13],
          ],
          true
        ).filter((i) => i.episode?.seasonNumber === 3)
      ),
      'S01, S03 pack (20 eps)'
    );
  });

  it('labels episodes by their numbers', () => {
    assert.equal(downloadLabel(intl, [item('a', 1, 2)]), 'S01E02');
    assert.equal(
      downloadLabel(intl, [item('a', 1, 3), item('a', 1, 2)]),
      'S01E02–E03',
      'a double episode on Sonarr 4'
    );
    assert.equal(
      downloadLabel(intl, [item('a', 1, 2), item('a', 1, 5)]),
      'S01 (2 eps)',
      'not consecutive'
    );
    assert.equal(
      downloadLabel(
        intl,
        pack('a', [[1, 2]], false).map((i, index) => ({
          ...i,
          episode: i.episode && { ...i.episode, episodeNumber: index + 4 },
        }))
      ),
      'S01E04–E05',
      'a Sonarr 5 double episode'
    );
    assert.equal(
      downloadLabel(intl, [item('a', 1, 2, { seasons: [] })]),
      'S01E02',
      'no seasons listed'
    );
  });

  it('has no label without episodes', () => {
    assert.equal(downloadScope([item('m')]), undefined);
    assert.equal(downloadLabel(intl, []), undefined);
  });
});
