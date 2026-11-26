import AiPickCard from '@app/components/Ai/AiPickCard';
import { useAiFeedback, useAiRun } from '@app/components/Ai/useAiRun';
import Slider from '@app/components/Slider';
import TitleCard from '@app/components/TitleCard';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowRightCircleIcon,
  CalendarDaysIcon,
} from '@heroicons/react/24/outline';
import type {
  AiPick,
  AiRun,
  AiVerdict,
} from '@shared/interfaces/api/aiInterfaces';
import { visibleAiPicks } from '@shared/lib/aiVisibility';
import { Permission } from '@shared/lib/permissions';
import { useIntl } from 'react-intl';
import { Link } from 'react-router';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.AiWeeklySlider', {
  feedbackFailed: 'Couldn’t save that. Try again.',
});

/**
 * The viewer's latest weekly AI picks as a Discover row. Hidden when AI is
 * off, they turned weekly picks off, or no week has been picked yet.
 */
const AiWeeklySlider = ({ title }: { title: string }) => {
  const intl = useIntl();
  const settings = useSettings();
  const { hasPermission } = useUser();
  const { addToast } = useToasts();
  const enabled = settings.currentSettings.aiEnabled === true;
  const { data, error } = useSWR<{ run: AiRun | null }>(
    enabled ? '/api/v1/ai/weekly' : null,
    { revalidateOnFocus: false }
  );
  const weekly = data?.run ?? null;
  // The run's own key carries feedback edits, shared with the AI Picks page.
  const { data: fresh, mutate } = useAiRun(weekly?.id ?? null);
  const run = fresh ?? weekly;
  const saveFeedback = useAiFeedback(run, mutate);

  const picks = visibleAiPicks(
    run?.result?.picks ?? [],
    settings.currentSettings,
    hasPermission([Permission.MANAGE_BLOCKLIST, Permission.VIEW_BLOCKLIST], {
      type: 'or',
    }),
    run?.request.availability
  );
  // Like the other personal rows: a placeholder while it loads, then
  // nothing once there turns out to be no picks.
  const loading = enabled && !data && !error;
  if (!loading && (!enabled || !run || picks.length === 0)) {
    return null;
  }

  const onFeedback = async (pick: AiPick, verdict: AiVerdict | null) => {
    try {
      await saveFeedback(pick, verdict);
    } catch {
      addToast(intl.formatMessage(messages.feedbackFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  return (
    <>
      <div className="slider-header">
        <Link
          to={run ? `/discover/ai?run=${run.id}` : '/discover/ai'}
          className="slider-title min-w-0"
        >
          <CalendarDaysIcon className="!ml-0 mr-2 !h-6 !w-6 shrink-0 text-indigo-400" />
          <span className="truncate">{title}</span>
          <ArrowRightCircleIcon />
        </Link>
      </div>
      {run?.result?.headline ? (
        <p className="-mt-1 mb-2 truncate text-sm text-gray-400">
          {run.result.headline}
        </p>
      ) : null}
      <Slider
        sliderKey="ai-weekly"
        ariaLabel={title}
        isLoading={loading}
        isEmpty={false}
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

export default AiWeeklySlider;
