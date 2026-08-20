import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { setupTestDb } from '@server/test/db';

setupTestDb();

const sendNotificationMock = mock.method(
  MediaRequest,
  'sendNotification',
  async () => undefined
).mock;

describe('ongoing episode request constraint', () => {
  it('allows only one active ongoing request for a media/quality pair', async () => {
    sendNotificationMock.resetCalls();
    const user = await getRepository(User).findOneByOrFail({
      email: 'admin@seerr.dev',
    });
    const media = await getRepository(Media).save(
      new Media({
        tmdbId: 987654,
        mediaType: MediaType.TV,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const duplicateMedia = await getRepository(Media).save(
      new Media({
        tmdbId: 987654,
        mediaType: MediaType.TV,
        status: MediaStatus.UNKNOWN,
        status4k: MediaStatus.UNKNOWN,
      })
    );
    const requestRepository = getRepository(MediaRequest);
    const ongoing = await requestRepository.save(
      new MediaRequest({
        type: MediaType.TV,
        media,
        requestedBy: user,
        status: MediaRequestStatus.PENDING,
        is4k: false,
        seasons: [],
        episodes: [],
        episodeSelectionType: 'after',
        ongoingEpisodeRequestKey: '987654:sd',
      })
    );

    const retiredDuplicate = await requestRepository.save(
      new MediaRequest({
        type: MediaType.TV,
        media: duplicateMedia,
        requestedBy: user,
        status: MediaRequestStatus.DECLINED,
        is4k: false,
        seasons: [],
        episodes: [],
        episodeSelectionType: 'after',
        ongoingEpisodeRequestKey: '987654:sd',
      })
    );

    retiredDuplicate.status = MediaRequestStatus.APPROVED;
    await assert.rejects(requestRepository.save(retiredDuplicate));

    ongoing.status = MediaRequestStatus.COMPLETED;
    await requestRepository.save(ongoing);

    await assert.doesNotReject(
      requestRepository.save(
        new MediaRequest({
          type: MediaType.TV,
          media,
          requestedBy: user,
          status: MediaRequestStatus.PENDING,
          is4k: false,
          seasons: [],
          episodes: [],
          episodeSelectionType: 'after',
          ongoingEpisodeRequestKey: '987654:sd',
        })
      )
    );
  });
});
