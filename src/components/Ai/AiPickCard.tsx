import Tooltip from '@app/components/Common/Tooltip';
import TitleCard from '@app/components/TitleCard';
import defineMessages from '@app/utils/defineMessages';
import {
  EyeIcon,
  HandThumbDownIcon,
  HandThumbUpIcon,
  NoSymbolIcon,
} from '@heroicons/react/24/outline';
import type { AiPick, AiVerdict } from '@shared/interfaces/api/aiInterfaces';
import type { MovieResult, TvResult } from '@shared/models/Search';
import type { ComponentType, SVGProps } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Ai.AiPickCard', {
  like: 'More like this',
  dislike: 'Not for me',
  seen: 'Already seen',
  notInterested: 'Don’t suggest this',
  undo: '{label} (tap again to undo)',
});

const VERDICTS: {
  kind: AiVerdict;
  label: keyof typeof messages;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  active: string;
}[] = [
  {
    kind: 'like',
    label: 'like',
    Icon: HandThumbUpIcon,
    active: 'bg-green-600 text-white border-green-500',
  },
  {
    kind: 'dislike',
    label: 'dislike',
    Icon: HandThumbDownIcon,
    active: 'bg-red-600 text-white border-red-500',
  },
  {
    kind: 'seen',
    label: 'seen',
    Icon: EyeIcon,
    active: 'bg-indigo-600 text-white border-indigo-500',
  },
  {
    kind: 'not_interested',
    label: 'notInterested',
    Icon: NoSymbolIcon,
    active: 'bg-gray-500 text-white border-gray-400',
  },
];

interface AiPickCardProps {
  pick: AiPick;
  onFeedback: (pick: AiPick, kind: AiVerdict | null) => void;
  /** Fill the grid cell instead of the fixed slider width. */
  canExpand?: boolean;
}

/** A title card with the model's reason and feedback buttons under it. */
const AiPickCard = ({ pick, onFeedback, canExpand }: AiPickCardProps) => {
  const intl = useIntl();
  const item = pick.item as unknown as MovieResult | TvResult;
  const isMovie = pick.mediaType === 'movie';
  const title = isMovie ? (item as MovieResult).title : (item as TvResult).name;
  const dimmed =
    pick.feedback === 'dislike' || pick.feedback === 'not_interested';

  return (
    <div
      className={`flex flex-col ${canExpand ? 'w-full' : 'w-36 sm:w-36 md:w-44'}`}
      data-testid="ai-pick"
    >
      <div className={dimmed ? 'opacity-40 transition' : 'transition'}>
        <TitleCard
          id={pick.tmdbId}
          isAddedToWatchlist={item.mediaInfo?.watchlists?.length ?? 0}
          image={item.posterPath}
          status={item.mediaInfo?.status}
          summary={item.overview}
          title={title}
          userScore={item.voteAverage}
          year={
            isMovie
              ? (item as MovieResult).releaseDate
              : (item as TvResult).firstAirDate
          }
          mediaType={pick.mediaType}
          inProgress={(item.mediaInfo?.downloadStatus ?? []).length > 0}
          canExpand={canExpand}
        />
      </div>
      <p
        className="mt-2 line-clamp-3 whitespace-normal text-xs leading-snug text-gray-300"
        title={pick.why}
      >
        {pick.why}
      </p>
      <div
        className="mt-2 flex gap-1"
        role="group"
        aria-label={intl.formatMessage(messages.like)}
      >
        {VERDICTS.map(({ kind, label, Icon, active }) => {
          const selected = pick.feedback === kind;
          const text = intl.formatMessage(messages[label]);
          return (
            <Tooltip
              key={kind}
              content={
                selected
                  ? intl.formatMessage(messages.undo, { label: text })
                  : text
              }
            >
              <button
                type="button"
                aria-label={text}
                aria-pressed={selected}
                onClick={() => onFeedback(pick, selected ? null : kind)}
                className={`flex h-8 min-w-0 flex-1 items-center justify-center rounded-md border transition focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                  selected
                    ? active
                    : 'border-gray-700 bg-gray-800/80 text-gray-400 hover:border-gray-500 hover:text-white'
                }`}
              >
                <Icon className="h-4 w-4" />
              </button>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
};

export default AiPickCard;
