import { parseExpression } from 'cron-parser';

export type CatchUpWeight = 'heavy' | 'light';

export interface CatchUpState {
  lastSucceededAt?: Date | null;
  lastFailedAt?: Date | null;
}

/** Returns whether one or more cron occurrences were missed. They coalesce. */
export const hasMissedOccurrence = (
  schedule: string,
  lastSucceededAt: Date | null | undefined,
  now = new Date()
): boolean => {
  if (!lastSucceededAt || lastSucceededAt >= now) return false;
  try {
    const iterator = parseExpression(schedule, {
      currentDate: lastSucceededAt,
      endDate: now,
    });
    iterator.next();
    return true;
  } catch {
    return false;
  }
};

export const canRunLaunchCatchUp = (
  schedule: string,
  weight: CatchUpWeight,
  state: CatchUpState,
  now = new Date()
): boolean => {
  if (!hasMissedOccurrence(schedule, state.lastSucceededAt, now)) return false;
  if (!state.lastFailedAt) return true;
  const delay = weight === 'heavy' ? 6 * 60 * 60_000 : 30 * 60_000;
  return now.getTime() - state.lastFailedAt.getTime() >= delay;
};
