import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isInteractiveImportQueueItem } from './mediaServarr';

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
