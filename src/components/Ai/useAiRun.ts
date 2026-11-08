import type {
  AiPick,
  AiRun,
  AiTaste,
  AiVerdict,
} from '@shared/interfaces/api/aiInterfaces';
import axios from 'axios';
import useSWR, { mutate as globalMutate } from 'swr';

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
  globalMutate('/api/v1/ai/taste', res.data, { revalidate: false });
  return res.data;
};
