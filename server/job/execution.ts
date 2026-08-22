import { getRepository } from '@server/datasource';
import { JobExecutionState } from '@server/entity/JobExecutionState';
import logger from '@server/logger';

const activeJobs = new Set<string>();
const activeControllers = new Map<string, AbortController>();
let activeHeavyJobs = 0;
let activeLightJobs = 0;

export type ManagedJobWeight = 'heavy' | 'light';

const summarizeFailure = (error: unknown): string =>
  String(error instanceof Error ? error.message : error)
    .replace(
      /(?:token|authorization|cookie|password)=?[^\s,;]+/gi,
      '[redacted]'
    )
    .slice(0, 512);

/** Signals managed work; callers also cancel their underlying scanner. */
export const cancelManagedJobs = (): void => {
  for (const controller of activeControllers.values()) {
    controller.abort();
  }
};

/** Run scheduled and manual work through one non-overlapping, persisted path. */
export const executeManagedJob = async (
  id: string,
  weight: ManagedJobWeight,
  run: (signal: AbortSignal) => Promise<unknown>
): Promise<boolean> => {
  if (
    activeJobs.has(id) ||
    (weight === 'heavy' && activeHeavyJobs >= 1) ||
    (weight === 'light' && activeLightJobs >= 2)
  ) {
    return false;
  }
  activeJobs.add(id);
  if (weight === 'heavy') activeHeavyJobs += 1;
  else activeLightJobs += 1;
  const controller = new AbortController();
  activeControllers.set(id, controller);
  let state: JobExecutionState | undefined;
  try {
    const repository = getRepository(JobExecutionState);
    const existing = await repository.findOne({ where: { jobId: id } });
    state = existing ?? new JobExecutionState({ jobId: id });
    state.lastStartedAt = new Date();
    await repository.save(state);
    await run(controller.signal);
    if (controller.signal.aborted) {
      state.lastCancelledAt = new Date();
      await repository.save(state);
      return false;
    }
    state.lastSucceededAt = new Date();
    state.consecutiveFailures = 0;
    state.lastFailureSummary = null;
    await repository.save(state);
    return true;
  } catch (error) {
    if (state && controller.signal.aborted) {
      state.lastCancelledAt = new Date();
      await getRepository(JobExecutionState).save(state);
      return false;
    }
    if (state) {
      state.lastFailedAt = new Date();
      state.lastFailureSummary = summarizeFailure(error);
      state.consecutiveFailures += 1;
      await getRepository(JobExecutionState).save(state);
    }
    logger.error(`Managed job failed: ${id}`, {
      label: 'Jobs',
      message: summarizeFailure(error),
    });
    return false;
  } finally {
    activeJobs.delete(id);
    activeControllers.delete(id);
    if (weight === 'heavy') activeHeavyJobs -= 1;
    else activeLightJobs -= 1;
  }
};
