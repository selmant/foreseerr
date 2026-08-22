import { getRepository } from '@server/datasource';
import { JobExecutionState } from '@server/entity/JobExecutionState';
import logger from '@server/logger';

const activeJobs = new Set<string>();
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

/** Run scheduled and manual work through one non-overlapping, persisted path. */
export const executeManagedJob = async (
  id: string,
  weight: ManagedJobWeight,
  run: (signal: AbortSignal) => Promise<void>
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
  const repository = getRepository(JobExecutionState);
  const existing = await repository.findOne({ where: { jobId: id } });
  const state = existing ?? new JobExecutionState({ jobId: id });
  state.lastStartedAt = new Date();
  await repository.save(state);
  const controller = new AbortController();
  try {
    await run(controller.signal);
    state.lastSucceededAt = new Date();
    state.consecutiveFailures = 0;
    state.lastFailureSummary = null;
    await repository.save(state);
    return true;
  } catch (error) {
    state.lastFailedAt = new Date();
    state.lastFailureSummary = summarizeFailure(error);
    state.consecutiveFailures += 1;
    await repository.save(state);
    logger.error(`Managed job failed: ${id}`, {
      label: 'Jobs',
      message: state.lastFailureSummary,
    });
    return false;
  } finally {
    activeJobs.delete(id);
    if (weight === 'heavy') activeHeavyJobs -= 1;
    else activeLightJobs -= 1;
  }
};
