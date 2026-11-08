import { AiPickPoster } from '@app/components/Ai/AiPickCard';
import { isWorking, useAiRun } from '@app/components/Ai/useAiRun';
import Slider from '@app/components/Slider';
import TitleCard from '@app/components/TitleCard';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowRightCircleIcon,
  LightBulbIcon,
} from '@heroicons/react/24/outline';
import type { AiErrorBody, AiRun } from '@shared/interfaces/api/aiInterfaces';
import { useIntl } from 'react-intl';
import { Link } from 'react-router';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.AiPicksSlider', {
  working: 'Finding picks for you…',
  empty: 'No picks yet. Open AI Picks to try a different idea.',
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
  const settings = useSettings();
  const enabled = settings.currentSettings.aiEnabled === true;
  const { data: row, error } = useSWR<RowResponse>(
    enabled ? `/api/v1/ai/row?sliderId=${sliderId}` : null,
    { revalidateOnFocus: false }
  );
  const rowRun = row?.run ?? null;
  // Polls while the row's run works.
  const { data: polled } = useAiRun(rowRun?.id ?? null);
  const run = polled ?? rowRun;

  if (!enabled) {
    return null;
  }

  const working = !row && !error ? true : isWorking(run);
  // Titles they passed on stay out of the row.
  const picks = (run?.result?.picks ?? []).filter(
    (p) => p.feedback !== 'dislike' && p.feedback !== 'not_interested'
  );
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
          <AiPickPoster key={`${pick.mediaType}-${pick.tmdbId}`} pick={pick} />
        ))}
      />
    </>
  );
};

export default AiPicksSlider;
