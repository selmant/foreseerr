import { episodeRequestStatus } from '@app/utils/episodeRequests';
import { MediaRequestStatus } from '@shared/constants/media';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('episodeRequestStatus', () => {
  it('lets a settled request speak for its episodes', () => {
    assert.equal(
      episodeRequestStatus(
        MediaRequestStatus.COMPLETED,
        MediaRequestStatus.APPROVED
      ),
      MediaRequestStatus.COMPLETED
    );
    assert.equal(
      episodeRequestStatus(
        MediaRequestStatus.DECLINED,
        MediaRequestStatus.PENDING
      ),
      MediaRequestStatus.DECLINED
    );
  });

  it('shows an open request episode by episode', () => {
    assert.equal(
      episodeRequestStatus(
        MediaRequestStatus.APPROVED,
        MediaRequestStatus.COMPLETED
      ),
      MediaRequestStatus.COMPLETED
    );
    assert.equal(episodeRequestStatus(undefined, undefined), undefined);
  });

  it('keeps an episode Sonarr cannot download failed', () => {
    assert.equal(
      episodeRequestStatus(
        MediaRequestStatus.COMPLETED,
        MediaRequestStatus.FAILED
      ),
      MediaRequestStatus.FAILED
    );
    assert.equal(
      episodeRequestStatus(
        MediaRequestStatus.APPROVED,
        MediaRequestStatus.FAILED
      ),
      MediaRequestStatus.FAILED
    );
  });
});
