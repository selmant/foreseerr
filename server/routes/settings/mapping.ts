import { getRepository } from '@server/datasource';
import { MappingGap } from '@server/entity/MappingGap';
import { MappingOverride } from '@server/entity/MappingOverride';
import { MappingSource } from '@server/entity/MappingSource';
import {
  budgetSnapshot,
  configureBudget,
  dailyUsage,
  flushBudgetUsage,
  resetCircuit,
} from '@server/lib/mapping/budget';
import {
  flushMappingGaps,
  listMappingGaps,
  summarizeMappingGaps,
} from '@server/lib/mapping/gaps';
import {
  loadMappingSourceEnabledState,
  retractPackFromGraph,
  setMappingSourceEnabled,
} from '@server/lib/mapping/graph';
import { suggestForOpenGaps } from '@server/lib/mapping/heuristic';
import {
  loadedPacks,
  packResolver,
  refreshPack,
} from '@server/lib/mapping/packs';
import {
  fetchManifest,
  type PackManifestEntry,
} from '@server/lib/mapping/packs/manifest';
import { snapshotPackProgress } from '@server/lib/mapping/packs/progress';
import { providerHealth } from '@server/lib/mapping/providerHealth';
import mappingService from '@server/lib/mapping/service';
import { isNamespace, seasonColumn } from '@server/lib/mapping/types';
import { Router } from 'express';

const mappingRoutes = Router();

const availableManifestPacks = (
  rows: MappingSource[],
  packs: PackManifestEntry[]
): PackManifestEntry[] =>
  packs.filter((pack) => !rows.some((row) => row.key === pack.key));

const sourceFromManifest = (
  pack: PackManifestEntry,
  enabled: boolean
): Partial<MappingSource> => {
  const now = new Date();
  return {
    key: pack.key,
    kind: 'pack',
    enabled,
    format: pack.format,
    mirrors: pack.mirrors,
    priority: pack.priority,
    trust: pack.trust,
    namespaceTrust: pack.namespaceTrust ?? null,
    fieldMap: pack.fieldMap ?? null,
    namespaceMap: pack.namespaceMap ?? null,
    licence: pack.licence ?? null,
    legalNote: pack.legalNote ?? null,
    costClass: pack.costClass ?? 'bulk',
    createdAt: now,
    updatedAt: now,
  };
};

mappingRoutes.get('/health', async (req, res, next) => {
  try {
    // Sightings are batched in memory, so flush before reporting or the page
    // shows a number the operator can prove wrong by reloading a slider.
    await flushMappingGaps();
    await flushBudgetUsage();
    const [sources, manifest] = await Promise.all([
      getRepository(MappingSource).find({
        order: { priority: 'ASC' },
      }),
      fetchManifest().catch(() => ({ packs: [] as PackManifestEntry[] })),
    ]);
    return res.status(200).json({
      gaps: await summarizeMappingGaps(),
      budgets: budgetSnapshot(),
      usage: await dailyUsage(7),
      sources: sources.map((source) => ({
        key: source.key,
        kind: source.kind,
        enabled: source.enabled,
        priority: source.priority,
        trust: source.trust,
        format: source.format,
        mirrors: source.mirrors,
        licence: source.licence,
        legalNote: source.legalNote,
        version: source.version,
        entryCount: source.entryCount,
        lastFetchedAt: source.lastFetchedAt,
        lastSuccessAt: source.lastSuccessAt,
        lastError: source.lastError,
        circuitState: source.circuitState,
        consecutiveFailures: source.consecutiveFailures,
        costClass: source.costClass,
        rps: source.rps,
        concurrency: source.concurrency,
        dailyQuota: source.dailyQuota,
      })),
      available: availableManifestPacks(sources, manifest.packs),
      resolvers: mappingService
        .registered()
        .map(({ key, kind, trust }) => ({ key, kind, trust })),
      providers: await providerHealth({
        force: req.query.probe === 'true',
      }),
      refreshes: snapshotPackProgress(),
    });
  } catch (error) {
    return next({
      status: 500,
      message: 'Unable to retrieve mapping health.',
      cause: error,
    });
  }
});

mappingRoutes.get('/gaps', async (req, res, next) => {
  try {
    await flushMappingGaps();
    const status =
      req.query.status === 'resolved' || req.query.status === 'ignored'
        ? req.query.status
        : 'open';
    const { results, total } = await listMappingGaps({
      status,
      discoverSource:
        typeof req.query.discoverSource === 'string'
          ? req.query.discoverSource
          : undefined,
      take: Number(req.query.take) || 50,
      skip: Number(req.query.skip) || 0,
    });
    return res.status(200).json({ results, total });
  } catch (error) {
    return next({
      status: 500,
      message: 'Unable to retrieve mapping gaps.',
      cause: error,
    });
  }
});

/**
 * Repair one gap by writing an override.
 *
 * An empty `toExternalId` is a deliberate "this does not exist anywhere", which
 * stops the resolver chain instead of letting a live resolver re-ask on every
 * render.
 */
/**
 * Attach unverified title matches to the busiest open gaps. Suggestions are
 * review material only: nothing here changes what the resolver chain returns.
 */
mappingRoutes.post('/gaps/suggest', async (req, res, next) => {
  try {
    const limit = Number(req.body?.limit ?? 50);
    const result = await suggestForOpenGaps({
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return res.status(200).json(result);
  } catch (error) {
    return next({
      status: 500,
      message: 'Unable to generate mapping suggestions.',
      cause: error,
    });
  }
});

mappingRoutes.post('/gaps/:id/resolve', async (req, res, next) => {
  try {
    const gap = await getRepository(MappingGap).findOne({
      where: { id: Number(req.params.id) },
    });
    if (!gap) return next({ status: 404, message: 'Mapping gap not found.' });

    const { toNamespace, toExternalId, toSeason, note, ignore } =
      req.body ?? {};
    if (ignore) {
      await getRepository(MappingGap).update(gap.id, { status: 'ignored' });
      return res.status(200).json({ status: 'ignored' });
    }
    if (!isNamespace(toNamespace)) {
      return next({ status: 400, message: 'A target namespace is required.' });
    }

    const overrides = getRepository(MappingOverride);
    const identity = {
      fromNamespace: gap.namespace,
      fromExternalId: gap.externalId,
      fromSeason: gap.season,
      toNamespace,
    };
    const existing = await overrides.findOne({ where: identity });
    const now = new Date();
    const patch = {
      toExternalId: String(toExternalId ?? ''),
      toSeason: seasonColumn(
        toSeason === undefined || toSeason === null
          ? undefined
          : Number(toSeason)
      ),
      note: typeof note === 'string' ? note : undefined,
      createdByUserId: req.user?.id,
      updatedAt: now,
    };
    if (existing) await overrides.update(existing.id, patch);
    else await overrides.insert({ ...identity, ...patch, createdAt: now });

    await getRepository(MappingGap).update(gap.id, { status: 'resolved' });
    // The chain caches misses, so the correction is invisible until this runs.
    mappingService.invalidate();

    return res.status(200).json({ status: 'resolved' });
  } catch (error) {
    return next({
      status: 500,
      message: 'Unable to resolve mapping gap.',
      cause: error,
    });
  }
});

mappingRoutes.get('/overrides', async (req, res, next) => {
  try {
    const results = await getRepository(MappingOverride).find({
      order: { updatedAt: 'DESC' },
      take: Math.min(1000, Number(req.query.take) || 200),
    });
    return res.status(200).json({ results });
  } catch (error) {
    return next({
      status: 500,
      message: 'Unable to retrieve mapping overrides.',
      cause: error,
    });
  }
});

/** Create a correction directly, without a queued gap to hang it off. */
mappingRoutes.post('/overrides', async (req, res, next) => {
  try {
    const {
      fromNamespace,
      fromExternalId,
      fromSeason,
      toNamespace,
      toExternalId,
      toSeason,
      note,
    } = req.body ?? {};
    if (!isNamespace(fromNamespace) || !isNamespace(toNamespace)) {
      return next({ status: 400, message: 'Unknown namespace.' });
    }
    if (!fromExternalId) {
      return next({ status: 400, message: 'A source id is required.' });
    }

    const repository = getRepository(MappingOverride);
    const identity = {
      fromNamespace,
      fromExternalId: String(fromExternalId),
      fromSeason: seasonColumn(fromSeason),
      toNamespace,
    };
    const now = new Date();
    const patch = {
      toExternalId: String(toExternalId ?? ''),
      toSeason: seasonColumn(toSeason),
      note: typeof note === 'string' ? note : undefined,
      createdByUserId: req.user?.id,
      updatedAt: now,
    };
    const existing = await repository.findOne({ where: identity });
    if (existing) await repository.update(existing.id, patch);
    else await repository.insert({ ...identity, ...patch, createdAt: now });

    // Any gap for the same item is now answered.
    await getRepository(MappingGap).update(
      {
        namespace: fromNamespace,
        externalId: String(fromExternalId),
        season: seasonColumn(fromSeason),
      },
      { status: 'resolved' }
    );
    mappingService.invalidate();

    return res.status(200).json({ status: 'saved' });
  } catch (error) {
    return next({
      status: 500,
      message: 'Unable to save mapping override.',
      cause: error,
    });
  }
});

mappingRoutes.delete('/overrides/:id', async (req, res, next) => {
  try {
    await getRepository(MappingOverride).delete(Number(req.params.id));
    mappingService.invalidate();
    return res.status(204).send();
  } catch (error) {
    return next({
      status: 500,
      message: 'Unable to delete mapping override.',
      cause: error,
    });
  }
});

/** Portable corrections: the same shape `/overrides` returns. */
mappingRoutes.post('/overrides/import', async (req, res, next) => {
  try {
    const rows = Array.isArray(req.body?.overrides) ? req.body.overrides : [];
    const repository = getRepository(MappingOverride);
    const now = new Date();
    let imported = 0;
    let skipped = 0;

    for (const row of rows) {
      if (!isNamespace(row?.fromNamespace) || !isNamespace(row?.toNamespace)) {
        skipped += 1;
        continue;
      }
      if (!row.fromExternalId) {
        skipped += 1;
        continue;
      }
      const identity = {
        fromNamespace: row.fromNamespace,
        fromExternalId: String(row.fromExternalId),
        fromSeason: seasonColumn(row.fromSeason),
        toNamespace: row.toNamespace,
      };
      const patch = {
        toExternalId: String(row.toExternalId ?? ''),
        toSeason: seasonColumn(row.toSeason),
        note: typeof row.note === 'string' ? row.note : undefined,
        createdByUserId: req.user?.id,
        updatedAt: now,
      };
      const existing = await repository.findOne({ where: identity });
      if (existing) await repository.update(existing.id, patch);
      else await repository.insert({ ...identity, ...patch, createdAt: now });
      await getRepository(MappingGap).update(
        {
          namespace: identity.fromNamespace,
          externalId: identity.fromExternalId,
          season: identity.fromSeason,
        },
        { status: 'resolved' }
      );
      imported += 1;
    }

    mappingService.invalidate();
    return res.status(200).json({ imported, skipped });
  } catch (error) {
    return next({
      status: 500,
      message: 'Unable to import mapping overrides.',
      cause: error,
    });
  }
});

mappingRoutes.get('/sources', async (req, res, next) => {
  try {
    const [rows, manifest] = await Promise.all([
      getRepository(MappingSource).find({ order: { priority: 'ASC' } }),
      fetchManifest().catch(() => ({ packs: [] })),
    ]);
    return res.status(200).json({
      results: rows,
      // Packs the manifest offers that have never been fetched here yet.
      available: availableManifestPacks(rows, manifest.packs),
    });
  } catch (error) {
    return next({
      status: 500,
      message: 'Unable to retrieve mapping sources.',
      cause: error,
    });
  }
});

mappingRoutes.post('/sources/:key', async (req, res, next) => {
  try {
    const repository = getRepository(MappingSource);
    let source = await repository.findOne({
      where: { key: req.params.key },
    });
    let created = false;
    if (!source) {
      const manifest = await fetchManifest().catch(() => ({
        packs: [] as PackManifestEntry[],
      }));
      const pack = manifest.packs.find((entry) => entry.key === req.params.key);
      if (!pack) {
        return next({ status: 404, message: 'Mapping source not found.' });
      }
      const enabled =
        typeof req.body?.enabled === 'boolean' ? req.body.enabled : true;
      await repository.insert(sourceFromManifest(pack, enabled));
      source = await repository.findOne({ where: { key: req.params.key } });
      if (!source) {
        return next({
          status: 500,
          message: 'Unable to create mapping source.',
        });
      }
      created = true;
    }

    const { enabled, priority, trust, rps, concurrency, dailyQuota, mirrors } =
      req.body ?? {};
    const wasEnabled = source.enabled;
    const patch: Partial<MappingSource> = { updatedAt: new Date() };
    if (typeof enabled === 'boolean') patch.enabled = enabled;
    if (Number.isFinite(priority)) patch.priority = Number(priority);
    if (Number.isFinite(trust)) patch.trust = Number(trust);
    if (Number.isFinite(rps)) patch.rps = Number(rps);
    if (Number.isFinite(concurrency)) patch.concurrency = Number(concurrency);
    if (Number.isFinite(dailyQuota)) patch.dailyQuota = Number(dailyQuota);
    if (Array.isArray(mirrors)) patch.mirrors = mirrors.map(String);
    await repository.update(source.id, patch);

    // Budget changes have to reach the running governor, not just the row.
    const merged = { ...source, ...patch };
    if (merged.rps || merged.concurrency || merged.dailyQuota) {
      configureBudget({
        key: merged.key,
        costClass: merged.costClass ?? 'bulk',
        rps: merged.rps ?? 1,
        burst: Math.max(1, merged.rps ?? 1),
        concurrency: merged.concurrency ?? 1,
        ...(merged.dailyQuota ? { dailyQuota: merged.dailyQuota } : {}),
        backpressure: merged.backpressure ?? 'none',
      });
    }

    if (merged.enabled === false && (created || wasEnabled)) {
      setMappingSourceEnabled(merged.key, false);
      mappingService.unregister(merged.key);
      await retractPackFromGraph(merged.key);
    } else if (
      merged.enabled &&
      (created || (typeof enabled === 'boolean' && !wasEnabled))
    ) {
      setMappingSourceEnabled(merged.key, true);
      if (merged.kind === 'pack') {
        const loaded = loadedPacks().find(
          (pack) => pack.entry.key === merged.key
        );
        if (loaded) {
          mappingService.register(packResolver(loaded));
        } else if (process.env.NODE_ENV !== 'test') {
          const manifest = await fetchManifest().catch(() => ({
            packs: [] as PackManifestEntry[],
          }));
          const entry = manifest.packs.find((pack) => pack.key === merged.key);
          if (entry) {
            void refreshPack(entry, {
              ingest: true,
              replacePackGraph: true,
            });
          }
        }
      } else {
        const { registerLiveResolvers } =
          await import('@server/lib/mapping/live');
        registerLiveResolvers({ force: true });
        const disabled = await loadMappingSourceEnabledState({ force: true });
        for (const key of disabled) mappingService.unregister(key);
      }
    }
    mappingService.invalidate();

    return res
      .status(200)
      .json(await repository.findOne({ where: { id: source.id } }));
  } catch (error) {
    return next({
      status: 500,
      message: 'Unable to update mapping source.',
      cause: error,
    });
  }
});

mappingRoutes.post('/sources/:key/refresh', async (req, res, next) => {
  try {
    const manifest = await fetchManifest();
    const entry = manifest.packs.find((pack) => pack.key === req.params.key);
    if (!entry) {
      return next({ status: 404, message: 'Mapping pack not in manifest.' });
    }
    return res
      .status(200)
      .json(await refreshPack(entry, { ingest: true, replacePackGraph: true }));
  } catch (error) {
    return next({
      status: 500,
      message: 'Unable to refresh mapping pack.',
      cause: error,
    });
  }
});

mappingRoutes.post('/sources/:key/reset-circuit', async (req, res, next) => {
  try {
    resetCircuit(req.params.key);
    await getRepository(MappingSource).update(
      { key: req.params.key },
      { circuitState: 'closed', consecutiveFailures: 0, lastError: null }
    );
    return res.status(200).json({ circuitState: 'closed' });
  } catch (error) {
    return next({
      status: 500,
      message: 'Unable to reset the circuit breaker.',
      cause: error,
    });
  }
});

export default mappingRoutes;
