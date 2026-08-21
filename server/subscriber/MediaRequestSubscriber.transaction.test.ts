import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { MediaRequestSubscriber } from '@server/subscriber/MediaRequestSubscriber';
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import type { EntityManager } from 'typeorm';

describe('MediaRequestSubscriber transactional lookups', () => {
  it('updateParentStatus reads media through the subscriber EntityManager', async () => {
    const media = new Media({
      id: 87,
      mediaType: MediaType.MOVIE,
      tmdbId: 787428,
      status: MediaStatus.PENDING,
      status4k: MediaStatus.UNKNOWN,
    });
    const entity = {
      id: 33,
      status: MediaRequestStatus.APPROVED,
      type: MediaType.MOVIE,
      is4k: false,
      media,
      seasons: [],
      episodes: [],
    } as unknown as MediaRequest;

    const findOne = mock.fn(async () => media);
    const save = mock.fn(async (value: Media) => value);
    const manager = {
      getRepository: (target: unknown) => {
        if (target === Media) {
          return { findOne, save };
        }
        return { find: async () => [], count: async () => 0 };
      },
    } as unknown as EntityManager;

    await new MediaRequestSubscriber().updateParentStatus(entity, manager);

    assert.equal(findOne.mock.callCount(), 1);
    assert.equal(save.mock.callCount(), 1);
    assert.equal(media.status, MediaStatus.PROCESSING);
  });

  it('pending request notifications use the attached media row', async () => {
    const sendNotification = mock.method(
      MediaRequest,
      'sendNotification',
      async () => undefined
    );
    const media = new Media({
      id: 87,
      mediaType: MediaType.MOVIE,
      tmdbId: 787428,
      status: MediaStatus.PENDING,
    });
    const request = new MediaRequest({
      id: 33,
      status: MediaRequestStatus.PENDING,
      type: MediaType.MOVIE,
      is4k: false,
      media,
    });

    await request.notifyNewRequest();

    assert.equal(sendNotification.mock.callCount(), 1);
    assert.equal(sendNotification.mock.calls[0].arguments[1], media);
    sendNotification.mock.restore();
  });
});
