import logger from '@server/logger';

/**
 * In-memory snapshot of in-flight mapping pack refreshes.
 *
 * The health endpoint reads this so the settings page can show download and
 * ingest progress without waiting for the blocking refresh POST to finish.
 */

export type PackRefreshPhase =
  | 'downloading'
  | 'validating'
  | 'parsing'
  | 'ingesting';

export interface PackRefreshProgress {
  key: string;
  phase: PackRefreshPhase;
  mirror?: string;
  bytesReceived?: number;
  bytesTotal?: number;
  recordsDone?: number;
  recordsTotal?: number;
  startedAt: string;
  updatedAt: string;
}

const active = new Map<string, PackRefreshProgress>();
const lastByteEmit = new Map<string, { at: number; received: number }>();
const lastLogAt = new Map<string, number>();

export const snapshotPackProgress = (): PackRefreshProgress[] => [
  ...active.values(),
];

export const beginPackProgress = (key: string): void => {
  const now = new Date().toISOString();
  active.set(key, {
    key,
    phase: 'downloading',
    startedAt: now,
    updatedAt: now,
  });
  lastByteEmit.delete(key);
  lastLogAt.delete(key);
};

export const updatePackProgress = (
  key: string,
  patch: Partial<Omit<PackRefreshProgress, 'key' | 'startedAt'>>
): void => {
  const current = active.get(key);
  if (!current) return;
  active.set(key, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  });
};

/** Throttle byte-level updates so a 100 MB pack does not churn the snapshot. */
export const reportDownloadBytes = (
  key: string,
  received: number,
  total: number | undefined,
  mirror: string
): void => {
  const previous = lastByteEmit.get(key);
  const now = Date.now();
  const finished = total != null && received >= total;
  if (
    previous &&
    !finished &&
    now - previous.at < 250 &&
    received - previous.received < 256 * 1024
  ) {
    return;
  }
  lastByteEmit.set(key, { at: now, received });
  updatePackProgress(key, {
    phase: 'downloading',
    bytesReceived: received,
    bytesTotal: total,
    mirror,
  });
  const lastLog = lastLogAt.get(key) ?? 0;
  if (finished || now - lastLog >= 2000) {
    lastLogAt.set(key, now);
    const percent =
      total != null && total > 0
        ? Math.round((100 * received) / total)
        : undefined;
    logger.info(
      percent != null
        ? `Downloading mapping pack ${key}: ${formatMb(received)} / ${formatMb(total ?? 0)} (${percent}%)`
        : `Downloading mapping pack ${key}: ${formatMb(received)}`,
      { label: 'Mapping', pack: key, mirror }
    );
  }
};

const formatMb = (bytes: number): string =>
  `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export const endPackProgress = (key: string): void => {
  active.delete(key);
  lastByteEmit.delete(key);
  lastLogAt.delete(key);
};

export const clearPackProgress = (): void => {
  active.clear();
  lastByteEmit.clear();
  lastLogAt.clear();
};
