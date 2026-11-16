import { useUser } from '@app/hooks/useUser';
import axios from 'axios';
import { visibleAiPicks } from '@shared/lib/aiVisibility';
import { Permission } from '@shared/lib/permissions';
import AiPickCard from '@app/components/Ai/AiPickCard';
import {
  isWorking,
  useAiFeedback,
  useAiRun,
} from '@app/components/Ai/useAiRun';
import Slider from '@app/components/Slider';
import TitleCard from '@app/components/TitleCard';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowRightCircleIcon,
  LightBulbIcon,
} from '@heroicons/react/24/outline';
import type {
  AiErrorBody,
  AiPick,
  AiRun,
  AiVerdict,
} from '@shared/interfaces/api/aiInterfaces';
import { useIntl } from 'react-intl';
import { useRef } from 'react';
import { Link } from 'react-router';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.AiPicksSlider', {
  working: 'Finding picks for you…',
  empty: 'No picks yet. Open AI Picks to try a different idea.',
  feedbackFailed: 'Couldn’t save that. Try again.',
});

interface AiPicksSliderProps {
  sliderKey: string;
  title: string;
  sliderId: number;
}

interface RowResponse {
  run: AiRun | null;
  notice: AiErrorBody | null;
}

/** A Discover row of AI picks for a prompt, personal to whoever views it. */
const AiPicksSlider = ({ sliderKey, title, sliderId }: AiPicksSliderProps) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const settings = useSettings();
  const { addToast } = useToasts();
  const enabled = settings.currentSettings.aiEnabled === true;
  const { data: row, error } = useSWR<RowResponse>(
    enabled ? `/api/v1/ai/row?sliderId=${sliderId}` : null,
    (url: string) =>
      axios
        .post<RowResponse>(url, {}, { headers: { 'X-Foreseerr-AI': '1' } })
        .then((res) => res.data),
    { revalidateOnFocus: false }
  );
  const rowRun = row?.run ?? null;
  // Polls while the row's run works; also carries feedback edits.
  const { data: polled, mutate } = useAiRun(rowRun?.id ?? null);
  const run = polled ?? rowRun;
  const saveFeedback = useAiFeedback(run, mutate);
  // Keep cards edited here mounted while their feedback panel is open.
  // Ratings arriving from either fetch still hide picks on cache reuse.
  const editedHere = useRef({ id: run?.id ?? null, keys: new Set<string>() });
  if (editedHere.current.id !== (run?.id ?? null)) {
    editedHere.current = { id: run?.id ?? null, keys: new Set() };
  }

  if (!enabled) {
    return null;
  }

  const onFeedback = async (pick: AiPick, verdict: AiVerdict | null) => {
    editedHere.current.keys.add(`${pick.mediaType}-${pick.tmdbId}`);
    try {
      await saveFeedback(pick, verdict);
    } catch {
      addToast(intl.formatMessage(messages.feedbackFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const working = !row && !error ? true : isWorking(run);
  const rated = new Set(
    [...(rowRun?.result?.picks ?? []), ...(run?.result?.picks ?? [])]
      .filter((pick) => pick.feedback != null)
      .map((pick) => `${pick.mediaType}-${pick.tmdbId}`)
  );
  const picks = visibleAiPicks(
    run?.result?.picks ?? [],
    settings.currentSettings,
    hasPermission([Permission.MANAGE_BLOCKLIST, Permission.VIEW_BLOCKLIST], {
      type: 'or',
    }),
    run?.request.availability
  ).filter((p) => {
    const key = `${p.mediaType}-${p.tmdbId}`;
    return !rated.has(key) || editedHere.current.keys.has(key);
  });
  const linkUrl = run ? `/discover/ai?run=${run.id}` : '/discover/ai';
  const emptyMessage =
    row?.notice?.message ??
    (run?.stage === 'failed' ? run.error?.message : undefined) ??
    intl.formatMessage(messages.empty);

  return (
    <>
      <div className="slider-header">
        <Link to={linkUrl} className="slider-title min-w-0">
          <LightBulbIcon className="!ml-0 mr-2 !h-6 !w-6 shrink-0 text-indigo-400" />
          <span className="truncate">{title}</span>
          <ArrowRightCircleIcon />
        </Link>
        {working && row ? (
          <span className="ml-3 shrink-0 text-xs text-gray-400" role="status">
            {intl.formatMessage(messages.working)}
          </span>
        ) : null}
      </div>
      {row?.notice && picks.length > 0 ? (
        <p className="-mt-1 mb-2 text-xs text-yellow-500">
          {row.notice.message}
        </p>
      ) : null}
      <Slider
        sliderKey={sliderKey}
        ariaLabel={title}
        isLoading={working}
        isEmpty={!working && picks.length === 0}
        emptyMessage={emptyMessage}
        placeholder={<TitleCard.Placeholder />}
        items={picks.map((pick) => (
          <AiPickCard
            key={`${pick.mediaType}-${pick.tmdbId}`}
            pick={pick}
            onFeedback={onFeedback}
          />
        ))}
      />
    </>
  );
};

export default AiPicksSlider;
