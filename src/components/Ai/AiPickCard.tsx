import Button from '@app/components/Common/Button';
import TitleCard from '@app/components/TitleCard';
import defineMessages from '@app/utils/defineMessages';
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/react';
import {
  EllipsisHorizontalIcon,
  EyeIcon,
  HandThumbDownIcon,
  HandThumbUpIcon,
  LightBulbIcon,
  NoSymbolIcon,
} from '@heroicons/react/24/outline';
import {
  CheckIcon,
  HandThumbUpIcon as HandThumbUpSolid,
} from '@heroicons/react/24/solid';
import type { AiPick, AiVerdict } from '@shared/interfaces/api/aiInterfaces';
import type { MovieResult, TvResult } from '@shared/models/Search';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import { Link } from 'react-router';

const messages = defineMessages('components.Ai.AiPickCard', {
  why: 'Why it fits',
  like: 'Like',
  liked: 'Liked',
  likeLabel: 'Like {title}: more picks like it',
  dislike: 'Not for me',
  dislikeLabel: '{title} is not for me',
  more: 'More options for {title}',
  seen: 'Already seen',
  notInterested: 'Don’t suggest this',
  seenState: 'Seen',
  hiddenState: 'Won’t be suggested again',
  undo: 'Undo',
});

/** The title, year and media item behind a pick. */
const describe = (pick: AiPick) => {
  const item = pick.item as unknown as MovieResult | TvResult;
  const isMovie = pick.mediaType === 'movie';
  return {
    item,
    title: isMovie ? (item as MovieResult).title : (item as TvResult).name,
    date: isMovie
      ? (item as MovieResult).releaseDate
      : (item as TvResult).firstAirDate,
  };
};

const Poster = ({
  pick,
  summary,
  hideCaption,
}: {
  pick: AiPick;
  summary?: string;
  hideCaption?: boolean;
}) => {
  const { item, title, date } = describe(pick);
  return (
    <TitleCard
      id={pick.tmdbId}
      isAddedToWatchlist={item.mediaInfo?.watchlists?.length ?? 0}
      image={item.posterPath}
      status={item.mediaInfo?.status}
      summary={summary}
      title={title}
      userScore={item.voteAverage}
      year={date}
      mediaType={pick.mediaType}
      inProgress={(item.mediaInfo?.downloadStatus ?? []).length > 0}
      canExpand
      hideCaption={hideCaption}
    />
  );
};

/**
 * A pick in a Discover row: the app's usual poster, nothing added at rest.
 * Hovering or tapping shows why it was picked where the summary would be.
 */
export const AiPickPoster = ({ pick }: { pick: AiPick }) => (
  <div className="w-36 sm:w-36 md:w-44" data-testid="ai-pick">
    <Poster pick={pick} summary={pick.why} />
  </div>
);

interface AiPickCardProps {
  pick: AiPick;
  onFeedback: (pick: AiPick, kind: AiVerdict | null) => void | Promise<void>;
}

/**
 * A pick on the AI Picks page: the poster (hover to request, as anywhere
 * in the app) beside why it fits, with quick feedback below.
 */
const AiPickCard = ({ pick, onFeedback }: AiPickCardProps) => {
  const intl = useIntl();
  const [saving, setSaving] = useState(false);
  const { title, date } = describe(pick);
  const year = date ? date.slice(0, 4) : null;
  const hidden =
    pick.feedback === 'dislike' || pick.feedback === 'not_interested';

  const give = async (kind: AiVerdict | null) => {
    if (saving) return;
    setSaving(true);
    try {
      await onFeedback(pick, kind);
    } finally {
      setSaving(false);
    }
  };
  const toggle = (kind: AiVerdict) =>
    void give(pick.feedback === kind ? null : kind);

  const selected =
    '!border-indigo-500 !bg-indigo-600/30 !text-white hover:!bg-indigo-600/40';

  return (
    <article
      className="flex gap-3 rounded-xl bg-gray-800/40 p-3 ring-1 ring-gray-700/70 transition hover:ring-gray-600 sm:gap-4 sm:p-4"
      data-testid="ai-pick"
      aria-busy={saving}
    >
      <div
        className={`w-32 shrink-0 transition sm:w-36 ${hidden ? 'opacity-40 grayscale' : ''}`}
      >
        <Poster pick={pick} hideCaption />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <Link
          to={`/${pick.mediaType}/${pick.tmdbId}`}
          className="line-clamp-2 text-base font-semibold leading-snug text-white hover:underline sm:text-lg"
        >
          {title}
        </Link>
        {year ? <p className="mt-0.5 text-xs text-gray-400">{year}</p> : null}
        <p className="mt-2.5 flex gap-2 text-sm leading-relaxed text-gray-300">
          <LightBulbIcon
            className="mt-0.5 h-4 w-4 shrink-0 text-indigo-300"
            aria-label={intl.formatMessage(messages.why)}
          />
          <span className="line-clamp-4">{pick.why}</span>
        </p>

        <div className="mt-auto flex flex-wrap items-center gap-2 pt-3">
          {hidden || pick.feedback === 'seen' ? (
            <span className="inline-flex min-h-8 items-center gap-2 text-xs text-gray-400">
              {pick.feedback === 'seen' ? (
                <EyeIcon className="h-4 w-4" />
              ) : (
                <NoSymbolIcon className="h-4 w-4" />
              )}
              <span>
                {intl.formatMessage(
                  pick.feedback === 'seen'
                    ? messages.seenState
                    : messages.hiddenState
                )}
              </span>
              <button
                type="button"
                disabled={saving}
                onClick={() => void give(null)}
                className="rounded font-medium text-indigo-300 hover:text-indigo-200 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                {intl.formatMessage(messages.undo)}
              </button>
            </span>
          ) : (
            <>
              <Button
                buttonSize="sm"
                disabled={saving}
                aria-pressed={pick.feedback === 'like'}
                aria-label={intl.formatMessage(messages.likeLabel, { title })}
                onClick={() => toggle('like')}
                className={`min-h-8 ${pick.feedback === 'like' ? selected : ''}`}
              >
                {pick.feedback === 'like' ? (
                  <HandThumbUpSolid className="mr-1.5 h-4 w-4 text-indigo-200" />
                ) : (
                  <HandThumbUpIcon className="mr-1.5 h-4 w-4" />
                )}
                <span>
                  {intl.formatMessage(
                    pick.feedback === 'like' ? messages.liked : messages.like
                  )}
                </span>
              </Button>
              <Button
                buttonSize="sm"
                disabled={saving}
                aria-label={intl.formatMessage(messages.dislikeLabel, {
                  title,
                })}
                onClick={() => toggle('dislike')}
                className="min-h-8"
              >
                <HandThumbDownIcon className="mr-1.5 h-4 w-4" />
                <span>{intl.formatMessage(messages.dislike)}</span>
              </Button>
            </>
          )}

          <Menu as="div" className="relative ml-auto">
            <MenuButton
              disabled={saving}
              aria-label={intl.formatMessage(messages.more, { title })}
              className="flex h-8 w-8 items-center justify-center rounded-md text-gray-400 transition hover:bg-gray-700 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50"
            >
              <EllipsisHorizontalIcon className="h-5 w-5" />
            </MenuButton>
            <MenuItems
              anchor="bottom end"
              className="z-50 mt-1 w-52 rounded-md border border-gray-700 bg-gray-800/95 p-1 shadow-lg backdrop-blur focus:outline-none"
            >
              {(
                [
                  ['seen', messages.seen, EyeIcon],
                  ['not_interested', messages.notInterested, NoSymbolIcon],
                ] as const
              ).map(([kind, label, Icon]) => (
                <MenuItem key={kind}>
                  <button
                    type="button"
                    onClick={() => toggle(kind)}
                    className="flex w-full items-center gap-3 rounded px-3 py-2 text-left text-sm text-gray-200 data-[focus]:bg-gray-700 data-[focus]:text-white"
                  >
                    <Icon className="h-4 w-4 shrink-0 text-gray-400" />
                    <span className="flex-1">{intl.formatMessage(label)}</span>
                    {pick.feedback === kind ? (
                      <CheckIcon className="h-4 w-4 shrink-0 text-indigo-300" />
                    ) : null}
                  </button>
                </MenuItem>
              ))}
            </MenuItems>
          </Menu>
        </div>
      </div>
    </article>
  );
};

/** A loading row card, the same shape as [`AiPickCard`]. */
export const AiPickCardPlaceholder = () => (
  <div className="flex animate-pulse gap-3 rounded-xl bg-gray-800/40 p-3 ring-1 ring-gray-700/70 sm:gap-4 sm:p-4">
    <div className="w-32 shrink-0 sm:w-36">
      <div className="w-full rounded-xl bg-gray-700/60 pb-[150%]" />
    </div>
    <div className="flex flex-1 flex-col gap-2 pt-1">
      <div className="h-4 w-2/3 rounded bg-gray-700/70" />
      <div className="h-3 w-1/4 rounded bg-gray-700/50" />
      <div className="mt-2 h-3 w-full rounded bg-gray-700/50" />
      <div className="h-3 w-5/6 rounded bg-gray-700/50" />
      <div className="mt-auto flex gap-2">
        <div className="h-8 w-16 rounded-md bg-gray-700/50" />
        <div className="h-8 w-24 rounded-md bg-gray-700/50" />
      </div>
    </div>
  </div>
);

export default AiPickCard;
