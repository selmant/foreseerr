import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';

import ServarrBase, { type QueueItem } from '@server/api/servarr/base';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { ServarrIntervention } from '@server/entity/ServarrIntervention';
import {
  INTERVENTION_IMPORT_TIMEOUT_MS,
  INTERVENTION_REJECTION_TIMEOUT_MS,
  failImportedIntervention,
  interventionRejectionTimeout,
  publicIntervention,
  reconcileServarrWarnings,
  rejectServarrIntervention,
  resolveImportedIntervention,
  startImportedIntervention,
} from '@server/lib/servarrInterventions';
import { getSettings, type RadarrSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';

setupTestDb();

const server: RadarrSettings = {
  id: 7,
  name: 'Radarr Test',
  hostname: 'localhost',
  port: 7878,
  apiKey: 'secret',
  useSsl: false,
  activeProfileId: 1,
  activeProfileName: 'Any',
  activeDirectory: '/movies',
  tags: [],
  is4k: false,
  isDefault: true,
  syncEnabled: true,
  preventSearch: false,
  tagRequests: false,
  overrideRule: [],
  minimumAvailability: 'released',
};

const warning = (overrides: Partial<QueueItem & { movieId: number }> = {}) =>
  ({
    id: 99,
    movieId: 1001,
    title: 'Example.Release.1080p',
    size: 100,
    sizeleft: 0,
    timeleft: '00:00:00',
    estimatedCompletionTime: new Date().toISOString(),
    status: 'completed',
    trackedDownloadStatus: 'warning',
    trackedDownloadState: 'importPending',
    downloadId: 'private-download-id',
    outputPath: '/private/download/path',
    protocol: 'torrent',
    downloadClient: 'client',
    indexer: 'indexer',
    statusMessages: [{ title: 'Import failed', messages: ['No files found'] }],
    ...overrides,
  }) as QueueItem & { movieId: number };

async function mappedMovie(overrides: Partial<Media> = {}) {
  return getRepository(Media).save(
    new Media({
      tmdbId: 5001,
      mediaType: MediaType.MOVIE,
      status: MediaStatus.UNKNOWN,
      status4k: MediaStatus.UNKNOWN,
      serviceId: server.id,
      externalServiceId: 1001,
      ...overrides,
    })
  );
}

async function activeWarning(now = new Date('2026-08-26T10:00:00.000Z')) {
  await mappedMovie();
  await reconcileServarrWarnings('radarr', server, [warning()], now);
  return getRepository(ServarrIntervention).findOneByOrFail({ queueId: 99 });
}

describe('Servarr warning reconciliation', () => {
  afterEach(() => {
    mock.restoreAll();
    getSettings().servarrInterventions = {
      automaticCleanupEnabled: false,
      cleanupGraceHours: 24,
    };
    getSettings().radarr = [];
  });

  it('detects only mapped warnings and classifies safe manual import capability', async () => {
    await mappedMovie();
    getSettings().servarrInterventions = {
      automaticCleanupEnabled: false,
      cleanupGraceHours: 24,
    };
    const now = new Date('2026-08-26T10:00:00.000Z');

    await reconcileServarrWarnings(
      'radarr',
      server,
      [
        warning(),
        warning({ id: 100, movieId: 9999 }),
        warning({
          id: 101,
          status: 'downloading',
          downloadId: undefined,
          outputPath: undefined,
        }),
      ],
      now
    );

    const records = await getRepository(ServarrIntervention).find({
      order: { queueId: 'ASC' },
    });
    assert.equal(records.length, 2);
    assert.equal(records[0].manualImportCapable, true);
    assert.equal(records[1].manualImportCapable, false);
    assert.deepEqual(records[0].warningMessages, ['No files found']);
    assert.equal(
      records[0].cleanupDeadlineAt.toISOString(),
      '2026-08-27T10:00:00.000Z'
    );
    const safe = publicIntervention(records[0]);
    assert.equal('queueId' in safe, false);
    assert.equal('downloadId' in safe, false);
    assert.equal('outputPath' in safe, false);
    assert.equal('actedByUserId' in safe, false);
  });

  it('does not duplicate an active occurrence and keeps the original deadline', async () => {
    await mappedMovie();
    const firstSeen = new Date('2026-08-26T10:00:00.000Z');
    await reconcileServarrWarnings('radarr', server, [warning()], firstSeen);
    getSettings().servarrInterventions.cleanupGraceHours = 1;
    await reconcileServarrWarnings(
      'radarr',
      server,
      [warning({ title: 'Updated title' })],
      new Date('2026-08-26T10:30:00.000Z')
    );
    const records = await getRepository(ServarrIntervention).find();
    assert.equal(records.length, 1);
    assert.equal(records[0].releaseTitle, 'Updated title');
    assert.equal(
      records[0].cleanupDeadlineAt.toISOString(),
      '2026-08-27T10:00:00.000Z'
    );
  });

  it('marks recovered vs disappeared only after a successful poll', async () => {
    await mappedMovie();
    await reconcileServarrWarnings(
      'radarr',
      server,
      [warning(), warning({ id: 100 })],
      new Date('2026-08-26T10:00:00.000Z')
    );

    await reconcileServarrWarnings(
      'radarr',
      server,
      [warning({ trackedDownloadStatus: 'ok' })],
      new Date('2026-08-26T11:00:00.000Z')
    );

    const records = await getRepository(ServarrIntervention).find({
      order: { queueId: 'ASC' },
    });
    assert.equal(records[0].resolution, 'recovered');
    assert.equal(records[1].resolution, 'disappeared');
  });

  it('creates a new occurrence after a resolved warning reappears', async () => {
    await mappedMovie();
    await reconcileServarrWarnings(
      'radarr',
      server,
      [warning()],
      new Date('2026-08-26T10:00:00.000Z')
    );
    await reconcileServarrWarnings(
      'radarr',
      server,
      [],
      new Date('2026-08-26T11:00:00.000Z')
    );
    await reconcileServarrWarnings(
      'radarr',
      server,
      [warning()],
      new Date('2026-08-26T12:00:00.000Z')
    );

    const records = await getRepository(ServarrIntervention).find({
      order: { id: 'ASC' },
    });
    assert.equal(records.length, 2);
    assert.equal(records[0].state, 'resolved');
    assert.equal(records[1].state, 'active');
  });

  it('maps duplicate Arr configs independently by service id', async () => {
    await mappedMovie();
    const otherServer: RadarrSettings = {
      ...server,
      id: 8,
      name: 'Radarr Duplicate',
    };
    await reconcileServarrWarnings('radarr', server, [warning()]);
    await reconcileServarrWarnings('radarr', otherServer, [warning()]);

    const records = await getRepository(ServarrIntervention).find();
    assert.equal(records.length, 1);
    assert.equal(records[0].serviceId, 7);
  });

  it('keeps an in-flight rejection in progress until it finishes or times out', async () => {
    const record = await activeWarning();
    record.state = 'rejecting';
    await getRepository(ServarrIntervention).save(record);

    await reconcileServarrWarnings('radarr', server, [warning()]);

    const updated = await getRepository(ServarrIntervention).findOneByOrFail({
      id: record.id,
    });
    assert.equal(updated.state, 'rejecting');
  });

  it('returns a stale rejection to active after the timeout', async () => {
    const record = await activeWarning();
    record.state = 'rejecting';
    await getRepository(ServarrIntervention).save(record);

    await reconcileServarrWarnings(
      'radarr',
      server,
      [warning()],
      new Date(Date.now() + INTERVENTION_REJECTION_TIMEOUT_MS + 1000)
    );

    const updated = await getRepository(ServarrIntervention).findOneByOrFail({
      id: record.id,
    });
    assert.equal(updated.state, 'active');
    assert.match(updated.cleanupError ?? '', /timed out/);
  });

  it('keeps an in-flight import in progress until it finishes or the two-hour safety net fires', async () => {
    const record = await activeWarning();
    record.state = 'importing';
    await getRepository(ServarrIntervention).save(record);

    await reconcileServarrWarnings('radarr', server, [warning()]);
    assert.equal(
      (
        await getRepository(ServarrIntervention).findOneByOrFail({
          id: record.id,
        })
      ).state,
      'importing'
    );

    await reconcileServarrWarnings(
      'radarr',
      server,
      [warning()],
      new Date(Date.now() + INTERVENTION_IMPORT_TIMEOUT_MS + 1000)
    );
    const updated = await getRepository(ServarrIntervention).findOneByOrFail({
      id: record.id,
    });
    assert.equal(updated.state, 'active');
    assert.match(updated.cleanupError ?? '', /Import timed out/);
  });

  it('resolves an importing warning as a manual import when it leaves the queue', async () => {
    const record = await activeWarning();
    record.state = 'importing';
    record.actedByUserId = 4;
    await getRepository(ServarrIntervention).save(record);

    await reconcileServarrWarnings('radarr', server, []);

    const updated = await getRepository(ServarrIntervention).findOneByOrFail({
      id: record.id,
    });
    assert.equal(updated.state, 'resolved');
    assert.equal(updated.resolution, 'manual_import');
  });

  it('does not automatically reject until cleanup is enabled and the deadline has passed', async () => {
    getSettings().radarr = [server];
    const remove = mock.method(
      ServarrBase.prototype,
      'removeQueueItem',
      async () => undefined
    );
    mock.method(ServarrBase.prototype, 'getQueue', async () => [warning()]);
    await mappedMovie();
    const firstSeen = new Date('2026-08-25T10:00:00.000Z');
    await reconcileServarrWarnings('radarr', server, [warning()], firstSeen);

    await reconcileServarrWarnings(
      'radarr',
      server,
      [warning()],
      new Date('2026-08-26T11:00:00.000Z')
    );
    assert.equal(remove.mock.callCount(), 0);
    assert.equal(
      (
        await getRepository(ServarrIntervention).findOneByOrFail({
          queueId: 99,
        })
      ).state,
      'active'
    );

    getSettings().servarrInterventions.automaticCleanupEnabled = true;
    await reconcileServarrWarnings(
      'radarr',
      server,
      [warning()],
      new Date('2026-08-26T11:00:00.000Z')
    );
    const updated = await getRepository(ServarrIntervention).findOneByOrFail({
      queueId: 99,
    });
    assert.equal(updated.state, 'resolved');
    assert.equal(updated.resolution, 'automatic_blocklist');
    assert.equal(remove.mock.callCount(), 1);
  });

  it('retries overdue cleanup after a failed Arr delete and continues other items', async () => {
    getSettings().radarr = [server];
    getSettings().servarrInterventions.automaticCleanupEnabled = true;
    await mappedMovie();
    await reconcileServarrWarnings(
      'radarr',
      server,
      [warning(), warning({ id: 100, title: 'Second.Release' })],
      new Date('2026-08-25T10:00:00.000Z')
    );

    mock.method(ServarrBase.prototype, 'getQueue', async () => [
      warning(),
      warning({ id: 100, title: 'Second.Release' }),
    ]);
    const remove = mock.method(
      ServarrBase.prototype,
      'removeQueueItem',
      async (queueId: number) => {
        if (queueId === 99) throw new Error('download client timeout');
      }
    );

    await reconcileServarrWarnings(
      'radarr',
      server,
      [warning(), warning({ id: 100, title: 'Second.Release' })],
      new Date('2026-08-26T11:00:00.000Z')
    );

    const records = await getRepository(ServarrIntervention).find({
      order: { queueId: 'ASC' },
    });
    assert.equal(remove.mock.callCount(), 2);
    assert.equal(records[0].state, 'active');
    assert.match(records[0].cleanupError ?? '', /download client timeout/);
    assert.equal(records[1].state, 'resolved');
    assert.equal(records[1].resolution, 'automatic_blocklist');
  });
});

describe('Servarr intervention rejection', () => {
  afterEach(() => {
    mock.restoreAll();
    getSettings().radarr = [];
    getSettings().servarrInterventions = {
      automaticCleanupEnabled: false,
      cleanupGraceHours: 24,
    };
  });

  it('revalidates the exact mapped warning before deleting with Arr blocklist flags', async () => {
    getSettings().radarr = [server];
    const record = await activeWarning();
    mock.method(ServarrBase.prototype, 'getQueue', async () => [warning()]);
    const remove = mock.method(
      ServarrBase.prototype,
      'removeQueueItem',
      async () => undefined
    );

    const result = await rejectServarrIntervention(record.id, 1);

    assert.equal(result.state, 'resolved');
    assert.equal(result.resolution, 'manual_blocklist');
    assert.equal(result.actedByUserId, 1);
    assert.equal(remove.mock.callCount(), 1);
    assert.deepEqual(remove.mock.calls[0].arguments, [
      99,
      { timeout: INTERVENTION_REJECTION_TIMEOUT_MS },
    ]);
  });

  it('refuses to delete when the live queue item is no longer a mapped warning', async () => {
    getSettings().radarr = [server];
    const record = await activeWarning();
    mock.method(ServarrBase.prototype, 'getQueue', async () => [
      warning({ trackedDownloadStatus: 'ok' }),
    ]);
    const remove = mock.method(
      ServarrBase.prototype,
      'removeQueueItem',
      async () => undefined
    );

    await assert.rejects(
      () => rejectServarrIntervention(record.id, 1),
      (error: Error & { status?: number }) => error.status === 409
    );
    assert.equal(remove.mock.callCount(), 0);
    const updated = await getRepository(ServarrIntervention).findOneByOrFail({
      id: record.id,
    });
    assert.equal(updated.state, 'active');
    assert.match(updated.cleanupError ?? '', /no longer mapped/);
  });

  it('rejects concurrent manual and automatic claims of the same warning', async () => {
    getSettings().radarr = [server];
    const record = await activeWarning();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let waitingOnQueue = false;
    mock.method(ServarrBase.prototype, 'getQueue', async () => {
      waitingOnQueue = true;
      await gate;
      return [warning()];
    });
    mock.method(
      ServarrBase.prototype,
      'removeQueueItem',
      async () => undefined
    );

    const first = rejectServarrIntervention(record.id, 1);
    while (!waitingOnQueue) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    await assert.rejects(
      () => rejectServarrIntervention(record.id, undefined, true),
      (error: Error & { status?: number }) => error.status === 409
    );
    release?.();
    const result = await first;
    assert.equal(result.resolution, 'manual_blocklist');
  });

  it('resolves a linked intervention after a successful import', async () => {
    const record = await activeWarning();
    await startImportedIntervention(record.id, 4);
    await resolveImportedIntervention(record.id, 4);
    const updated = await getRepository(ServarrIntervention).findOneByOrFail({
      id: record.id,
    });
    assert.equal(updated.state, 'resolved');
    assert.equal(updated.resolution, 'manual_import');
    assert.equal(updated.actedByUserId, 4);
  });

  it('returns an importing warning to active when the Arr command fails', async () => {
    const record = await activeWarning();
    await startImportedIntervention(record.id, 4);
    await failImportedIntervention(record.id, 'disk full');
    const updated = await getRepository(ServarrIntervention).findOneByOrFail({
      id: record.id,
    });
    assert.equal(updated.state, 'active');
    assert.match(updated.cleanupError ?? '', /disk full/);
  });

  it('times out a hung Arr rejection', async () => {
    getSettings().radarr = [server];
    const record = await activeWarning();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mock.method(ServarrBase.prototype, 'getQueue', async () => {
      await gate;
      return [warning()];
    });
    mock.method(
      ServarrBase.prototype,
      'removeQueueItem',
      async () => undefined
    );

    await assert.rejects(
      () => rejectServarrIntervention(record.id, 1, false, 20),
      (error: Error & { status?: number }) => error.status === 504
    );
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const updated = await getRepository(ServarrIntervention).findOneByOrFail({
      id: record.id,
    });
    assert.equal(updated.state, 'active');
    assert.match(updated.cleanupError ?? '', /timed out/);
  });

  it('floors a disabled API timeout to two minutes for rejection', () => {
    assert.equal(
      interventionRejectionTimeout(0),
      INTERVENTION_REJECTION_TIMEOUT_MS
    );
  });

  it('leaves the intervention actionable when import resolution is skipped', async () => {
    const record = await activeWarning();
    const updated = await getRepository(ServarrIntervention).findOneByOrFail({
      id: record.id,
    });
    assert.equal(updated.state, 'active');
    assert.equal(updated.resolution ?? null, null);
  });
});
