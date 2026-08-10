import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canGrabRelease,
  episodeQueueStatus,
  isInteractiveImportQueueItem,
} from './mediaServarr';

describe('Servarr interactive import eligibility', () => {
  const base = {
    title: 'Example.Release',
    downloadId: 'download-id',
    outputPath: '/downloads/example',
    status: 'completed',
    trackedDownloadStatus: 'warning' as const,
  };

  it('accepts the native completed-warning queue state', () => {
    assert.equal(isInteractiveImportQueueItem(base), true);
  });

  it('rejects completed downloads Arr can import normally', () => {
    assert.equal(
      isInteractiveImportQueueItem({
        ...base,
        trackedDownloadStatus: 'ok',
      }),
      false
    );
  });

  it('rejects warning downloads that are not completed', () => {
    assert.equal(
      isInteractiveImportQueueItem({ ...base, status: 'downloading' }),
      false
    );
  });

  it('rejects queue records without a safe Arr download source', () => {
    assert.equal(
      isInteractiveImportQueueItem({ ...base, downloadId: undefined }),
      false
    );
    assert.equal(
      isInteractiveImportQueueItem({ ...base, outputPath: undefined }),
      false
    );
  });
});

describe('Servarr rejected release override', () => {
  const release = {
    guid: 'release-guid',
    indexerId: 1,
    title: 'Example release',
    size: 1,
    ageHours: 1,
    publishDate: '2026-08-10T00:00:00.000Z',
    indexer: 'Example indexer',
    protocol: 'torrent',
    approved: false,
    rejected: false,
    temporarilyRejected: false,
    downloadAllowed: false,
  };

  it('allows an explicitly acknowledged quality-rejected release to be grabbed', () => {
    assert.equal(canGrabRelease({ ...release, rejected: true }), true);
    assert.equal(
      canGrabRelease({ ...release, temporarilyRejected: true }),
      true
    );
  });

  it('continues to block an unavailable non-rejected release', () => {
    assert.equal(canGrabRelease(release), false);
  });
});

describe('Sonarr episode queue status', () => {
  it('prioritizes active downloads and import work over library state', () => {
    assert.equal(
      episodeQueueStatus({ title: 'Episode', status: 'downloading' }),
      'downloading'
    );
    assert.equal(
      episodeQueueStatus({ title: 'Episode', status: 'importing' }),
      'importing'
    );
    assert.equal(
      episodeQueueStatus({
        title: 'Episode',
        status: 'completed',
        trackedDownloadStatus: 'warning',
      }),
      'manual-import'
    );
  });

  it('shows queued work without treating normal completed downloads as active', () => {
    assert.equal(
      episodeQueueStatus({ title: 'Episode', status: 'queued' }),
      'queued'
    );
    assert.equal(
      episodeQueueStatus({ title: 'Episode', status: 'completed' }),
      undefined
    );
  });
});
