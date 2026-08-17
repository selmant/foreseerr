import { MediaRequestStatus, MediaType } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import { getRequestRelevanceReason } from '@server/lib/releases/relevance';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const occurrence = {
  id: 1,
  mediaId: 10,
  mediaType: MediaType.TV,
  is4k: false,
  seasonNumber: 2,
  tvdbId: 200,
};

const asRequest = (
  overrides: Partial<MediaRequest> &
    Pick<MediaRequest, 'episodes' | 'seasons' | 'status'>
) => overrides as MediaRequest;

describe('getRequestRelevanceReason', () => {
  it('does not mark the whole series mine for episode-only requests', () => {
    const reason = getRequestRelevanceReason(
      occurrence,
      asRequest({
        status: MediaRequestStatus.APPROVED,
        episodeSelectionType: 'single',
        episodes: [{ tvdbId: 101 }] as MediaRequest['episodes'],
        seasons: [],
      })
    );
    assert.equal(reason, undefined);
  });

  it('still matches the requested episode', () => {
    const reason = getRequestRelevanceReason(
      { ...occurrence, tvdbId: 101, seasonNumber: 1 },
      asRequest({
        status: MediaRequestStatus.APPROVED,
        episodeSelectionType: 'single',
        episodes: [{ tvdbId: 101 }] as MediaRequest['episodes'],
        seasons: [],
      })
    );
    assert.equal(reason, 'requested_episode');
  });

  it('keeps later seasons relevant for a series request', () => {
    const reason = getRequestRelevanceReason(
      occurrence,
      asRequest({
        status: MediaRequestStatus.APPROVED,
        episodes: [],
        seasons: [{ seasonNumber: 1 }] as MediaRequest['seasons'],
      })
    );
    assert.equal(reason, 'requested_series');
  });
});
