import type { MediaActionAggregate } from './types';

export type MediaActionWriteOutcome = 'success' | 'partial' | 'failure';

/**
 * Classify a write fan-out result.
 * - failure: no enabled providers, or every enabled provider rejected
 * - partial: at least one success and at least one failure (multi-provider)
 * - success: every attempted provider succeeded
 */
export function classifyWriteOutcome(
  result: MediaActionAggregate
): MediaActionWriteOutcome {
  const providers = result.providers;
  if (providers.length === 0) {
    return 'failure';
  }
  const okCount = providers.filter((p) => p.ok).length;
  if (okCount === 0) {
    return 'failure';
  }
  if (okCount < providers.length) {
    return 'partial';
  }
  return 'success';
}

/** HTTP status for write mutations. Reads stay 200 even when providers degrade. */
export function writeHttpStatus(outcome: MediaActionWriteOutcome): number {
  switch (outcome) {
    case 'success':
      return 200;
    case 'partial':
      return 207;
    case 'failure':
      return 502;
  }
}
