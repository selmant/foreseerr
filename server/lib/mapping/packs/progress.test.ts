import {
  beginPackProgress,
  clearPackProgress,
  reportDownloadBytes,
  snapshotPackProgress,
} from '@server/lib/mapping/packs/progress';
import logger from '@server/logger';
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

describe('reportDownloadBytes', () => {
  afterEach(() => {
    clearPackProgress();
    mock.restoreAll();
  });

  it('drops a compressed Content-Length once the decoded bytes outgrow it', () => {
    const info = mock.method(logger, 'info', () => logger);
    beginPackProgress('animeapi');
    const compressed = 3_000_000;
    for (let chunk = 1; chunk <= 200; chunk++) {
      reportDownloadBytes('animeapi', chunk * 64 * 1024, compressed, 'mirror');
    }

    // A total the download passed is not "finished", so logging stays throttled.
    assert.equal(info.mock.callCount(), 1);
    const [progress] = snapshotPackProgress();
    assert.equal(progress.bytesTotal, undefined);
    assert.ok((progress.bytesReceived ?? 0) > compressed);
  });

  it('keeps an accurate total and logs completion', () => {
    const info = mock.method(logger, 'info', () => logger);
    beginPackProgress('fribb');
    reportDownloadBytes('fribb', 512 * 1024, 1024 * 1024, 'mirror');
    reportDownloadBytes('fribb', 1024 * 1024, 1024 * 1024, 'mirror');

    assert.equal(info.mock.callCount(), 2);
    assert.match(String(info.mock.calls[1].arguments[0]), /\(100%\)/);
    assert.equal(snapshotPackProgress()[0].bytesTotal, 1024 * 1024);
  });
});
