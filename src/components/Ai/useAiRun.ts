import { AiFeedbackQueue } from '@shared/lib/aiFeedback';
import type {
  AiPick,
  AiRun,
  AiTaste,
  AiVerdict,
} from '@shared/interfaces/api/aiInterfaces';
import axios from 'axios';
import useSWR, { useSWRConfig, type KeyedMutator } from 'swr';

export const isWorking = (run?: AiRun | null): boolean =>
  !!run && ['planning', 'searching', 'ranking'].includes(run.stage);

/** A run, polled while it works. */
export const useAiRun = (runId: number | null) =>
  useSWR<AiRun>(runId ? `/api/v1/ai/runs/${runId}` : null, {
    refreshInterval: (latest) => (!latest || isWorking(latest) ? 1500 : 0),
    revalidateOnFocus: false,
  });

/** The same pick with new feedback, in a run. */
export const withFeedback = (
  run: AiRun,
  pick: AiPick,
  kind: AiVerdict | null
): AiRun => ({
  ...run,
  result: run.result
    ? {
        ...run.result,
        picks: run.result.picks.map((p) =>
          p.mediaType === pick.mediaType && p.tmdbId === pick.tmdbId
            ? { ...p, feedback: kind }
            : p
        ),
      }
    : null,
});

/** Save feedback on a pick (null clears it); refreshes the taste card. */
export const sendFeedback = async (pick: AiPick, kind: AiVerdict | null) => {
  const item = pick.item as { title?: string; name?: string };
  const res = await axios.post<AiTaste>('/api/v1/ai/feedback', {
    mediaType: pick.mediaType,
    tmdbId: pick.tmdbId,
    kind,
    title: item.title ?? item.name ?? '',
  });
  return res.data;
};

const feedbackQueue = new AiFeedbackQueue();
const isAiCache = (key: unknown): boolean =>
  typeof key === 'string' &&
  (key.startsWith('/api/v1/ai/runs/') || key.startsWith('/api/v1/ai/row?'));

type CachedPicks = AiRun | { run: AiRun | null };
const updateCachedPick = (
  current: CachedPicks | undefined,
  pick: AiPick,
  kind: AiVerdict | null
) => {
  if (!current) return current;
  if ('run' in current)
    return {
      ...current,
      run: current.run ? withFeedback(current.run, pick, kind) : null,
    };
  return withFeedback(current, pick, kind);
};

/** One edit identity per title, ordered writes, and synchronized SWR run/row caches. */
export const useAiFeedback = (
  run: AiRun | null | undefined,
  mutateRun: KeyedMutator<AiRun>
) => {
  const { mutate } = useSWRConfig();
  return async (pick: AiPick, kind: AiVerdict | null) => {
    if (!run) return;
    const taste = await feedbackQueue.submit(
      `${pick.mediaType}-${pick.tmdbId}`,
      pick.feedback ?? null,
      kind,
      () => sendFeedback(pick, kind),
      async (value, isCurrent) => {
        await mutateRun(
          (current) =>
            isCurrent() ? withFeedback(current ?? run, pick, value) : current,
          { revalidate: false }
        );
        await mutate(
          isAiCache,
          (current: CachedPicks | undefined) =>
            isCurrent() ? updateCachedPick(current, pick, value) : current,
          { revalidate: false }
        );
      }
    );
    await mutate('/api/v1/ai/taste', taste, { revalidate: false });
    await mutate('/api/v1/ai/feedback');
  };
};
