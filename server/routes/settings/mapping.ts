import {
  datasetDefinition,
  listDatasets,
  refreshDataset,
  setDatasetEnabled,
} from '@server/lib/mapping/datasets';
import { snapshotPackProgress } from '@server/lib/mapping/progress';
import {
  countResolutions,
  deleteResolutions,
  flushMisses,
  listResolutions,
  saveManual,
  type ResolutionList,
} from '@server/lib/mapping/resolutions';
import { invalidateResolutions } from '@server/lib/mapping/resolve';
import {
  isNamespace,
  tmdbMediaType,
  type MediaType,
  type Namespace,
} from '@server/lib/mapping/types';
import { Router } from 'express';

const mappingRoutes = Router();

const LISTS: ResolutionList[] = ['unmapped', 'manual', 'guessed'];

mappingRoutes.get('/status', async (_req, res, next) => {
  try {
    // Sightings are batched in memory, so flush before reporting or the page
    // shows a number the operator can prove wrong by reloading a slider.
    await flushMisses();
    const refreshes = snapshotPackProgress();
    return res.status(200).json({
      datasets: (await listDatasets()).map((dataset) => ({
        key: dataset.key,
        enabled: dataset.enabled,
        licence: dataset.licence,
        note: dataset.note,
        edgeCount: dataset.edgeCount,
        version: dataset.version,
        lastFetchedAt: dataset.lastFetchedAt,
        lastSuccessAt: dataset.lastSuccessAt,
        lastError: dataset.lastError,
        refresh: refreshes.find((refresh) => refresh.key === dataset.key),
      })),
      counts: await countResolutions(),
    });
  } catch (error) {
    return next({
      status: 500,
      message: 'Unable to retrieve mapping status.',
      cause: error,
    });
  }
});

/**
 * Stored mappings by kind: `unmapped` items most-seen first, `manual`
 * corrections, or `guessed` answers from the title and prequel fallback.
 */
mappingRoutes.get('/resolutions', async (req, res, next) => {
  try {
    const list = LISTS.find((candidate) => candidate === req.query.list);
    if (!list) {
      return next({ status: 400, message: 'Unknown mapping list.' });
    }
    if (list === 'unmapped') await flushMisses();
    return res.status(200).json(
      await listResolutions(list, {
        take: Number(req.query.take) || 50,
        skip: Number(req.query.skip) || 0,
      })
    );
  } catch (error) {
    return next({
      status: 500,
      message: 'Unable to retrieve mappings.',
      cause: error,
    });
  }
});

interface CorrectionBody {
  srcNs?: unknown;
  srcId?: unknown;
  tmdbId?: unknown;
  tmdbType?: unknown;
  note?: unknown;
  /** What an exported correction calls its note. */
  detail?: unknown;
  // The override export written before the mapping rebuild.
  fromNamespace?: unknown;
  fromExternalId?: unknown;
  toNamespace?: unknown;
  toExternalId?: unknown;
}

/**
 * Read a correction in the current shape, or in the shape of an override
 * exported before the rebuild so old exports still import.
 */
const parseCorrection = (
  body: CorrectionBody
):
  | {
      srcNs: Namespace;
      srcId: string;
      tmdbId: number | null;
      tmdbType: MediaType | null;
      note?: string;
    }
  | undefined => {
  const srcNs = body.srcNs ?? body.fromNamespace;
  const srcId = body.srcId ?? body.fromExternalId;
  if (!isNamespace(srcNs) || !srcId) return undefined;

  const legacyType =
    typeof body.toNamespace === 'string'
      ? tmdbMediaType(body.toNamespace)
      : undefined;
  // An old override aimed at TVDB or IMDb has no equivalent here.
  if (body.toNamespace !== undefined && !legacyType) return undefined;
  const tmdbType =
    body.tmdbType === 'movie' || body.tmdbType === 'tv'
      ? body.tmdbType
      : legacyType;
  const rawId = body.tmdbId ?? body.toExternalId;
  const rawNote = typeof body.note === 'string' ? body.note : body.detail;
  const note = typeof rawNote === 'string' ? rawNote.trim() : '';

  // No id at all is a deliberate "this has no TMDB counterpart". Anything
  // else has to be a real id: a typo must not quietly hide the title.
  if (rawId === undefined || rawId === null || rawId === '') {
    return {
      srcNs,
      srcId: String(srcId),
      tmdbId: null,
      tmdbType: null,
      ...(note ? { note } : {}),
    };
  }
  const tmdbId =
    typeof rawId === 'number' || /^\d+$/.test(String(rawId).trim())
      ? Number(rawId)
      : NaN;
  if (!tmdbType || !Number.isInteger(tmdbId) || tmdbId <= 0) return undefined;
  return {
    srcNs,
    srcId: String(srcId),
    tmdbId,
    tmdbType,
    ...(note ? { note } : {}),
  };
};

const storeCorrection = (
  correction: NonNullable<ReturnType<typeof parseCorrection>>,
  userId?: number
): Promise<void> =>
  saveManual({
    ref: { ns: correction.srcNs, id: correction.srcId },
    tmdbId: correction.tmdbId,
    tmdbType: correction.tmdbType,
    detail: correction.note,
    createdByUserId: userId,
  });

/**
 * Save a correction. It wins over every automatic step, including the
 * datasets, and nothing but another correction can change it.
 */
mappingRoutes.post('/corrections', async (req, res, next) => {
  try {
    const correction = parseCorrection(req.body ?? {});
    if (!correction) {
      return next({
        status: 400,
        message: 'A source namespace, source id and TMDB type are required.',
      });
    }
    await storeCorrection(correction, req.user?.id);
    invalidateResolutions();
    return res.status(200).json({ status: 'saved' });
  } catch (error) {
    return next({
      status: 500,
      message: 'Unable to save the mapping correction.',
      cause: error,
    });
  }
});

mappingRoutes.post('/corrections/import', async (req, res, next) => {
  try {
    const rows: CorrectionBody[] = Array.isArray(req.body?.corrections)
      ? req.body.corrections
      : [];
    let imported = 0;
    let skipped = 0;
    for (const row of rows) {
      const correction = parseCorrection(row ?? {});
      if (!correction) {
        skipped += 1;
        continue;
      }
      await storeCorrection(correction, req.user?.id);
      imported += 1;
    }
    invalidateResolutions();
    return res.status(200).json({ imported, skipped });
  } catch (error) {
    return next({
      status: 500,
      message: 'Unable to import mapping corrections.',
      cause: error,
    });
  }
});

/**
 * Forget one stored mapping: undo a correction, discard a guess so it is
 * worked out again, or dismiss an unmapped item.
 */
mappingRoutes.delete('/resolutions/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return next({ status: 400, message: 'A mapping id is required.' });
    }
    await deleteResolutions([id]);
    invalidateResolutions();
    return res.status(204).send();
  } catch (error) {
    return next({
      status: 500,
      message: 'Unable to delete the mapping.',
      cause: error,
    });
  }
});

mappingRoutes.post('/datasets/:key', async (req, res, next) => {
  try {
    if (!datasetDefinition(req.params.key)) {
      return next({ status: 404, message: 'Mapping dataset not found.' });
    }
    if (typeof req.body?.enabled !== 'boolean') {
      return next({ status: 400, message: '`enabled` must be a boolean.' });
    }
    const dataset = await setDatasetEnabled(req.params.key, req.body.enabled);
    // Fetched in the background; the status endpoint reports progress.
    if (req.body.enabled && process.env.NODE_ENV !== 'test') {
      void refreshDataset(req.params.key);
    }
    return res.status(200).json(dataset);
  } catch (error) {
    return next({
      status: 500,
      message: 'Unable to update the mapping dataset.',
      cause: error,
    });
  }
});

mappingRoutes.post('/datasets/:key/refresh', async (req, res, next) => {
  try {
    if (!datasetDefinition(req.params.key)) {
      return next({ status: 404, message: 'Mapping dataset not found.' });
    }
    return res
      .status(200)
      .json(await refreshDataset(req.params.key, { force: true }));
  } catch (error) {
    return next({
      status: 500,
      message: 'Unable to refresh the mapping dataset.',
      cause: error,
    });
  }
});

export default mappingRoutes;
