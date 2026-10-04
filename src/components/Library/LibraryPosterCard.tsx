import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import {
  isLibraryEpisodePoster,
  isLibrarySeriesPoster,
  libraryWatchMark,
  overlayTitleActionWatched,
} from '@app/components/Library/libraryPosterWatchMark';
import useLibraryPlay from '@app/components/Library/useLibraryPlay';
import { useTitleCardBatch } from '@app/components/TitleCard/TitleCardBatchContext';
import { useIsTouch } from '@app/hooks/useIsTouch';
import defineMessages from '@app/utils/defineMessages';
import { CheckBadgeIcon, PlayIcon } from '@heroicons/react/24/solid';
import type { LibraryTitle } from '@server/interfaces/api/libraryInterfaces';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Library.LibraryPosterCard', {
  play: 'Play',
  resume: 'Resume',
  movie: 'Movie',
  series: 'Series',
  episode: 'Episode',
  unwatched: 'Unwatched',
  watched: 'Watched',
  remaining:
    '{count, plural, one {# unwatched episode} other {# unwatched episodes}}',
  unavailable: 'No episodes available',
  progress: '{percent, number}% watched',
});

interface LibraryPosterCardProps {
  item: LibraryTitle;
  compact?: boolean;
  surface?: 'overview' | 'browse';
  onOpen?: (item: LibraryTitle) => void;
}

const LibraryPosterCard = ({
  item,
  compact = false,
  surface,
  onOpen,
}: LibraryPosterCardProps) => {
  const intl = useIntl();
  const isTouch = useIsTouch();
  const { playItem } = useLibraryPlay();
  const batch = useTitleCardBatch();
  const mode = surface ?? (compact ? 'browse' : 'overview');
  const isBrowse = mode === 'browse';
  const progress = item.progressPercent ?? 0;
  const isResume = progress > 0 && progress < 95;
  const isEpisodePoster = isLibraryEpisodePoster(item);
  const typeLabel = intl.formatMessage(
    item.mediaType === 'movie'
      ? messages.movie
      : isEpisodePoster
        ? messages.episode
        : messages.series
  );
  const isSeriesPoster = isLibrarySeriesPoster(item);
  // Episodes share the show TMDB id with title-level Trakt/AniList watched.
  // Never overlay that onto Jellyfin episode play state.
  const actionWatched =
    !isEpisodePoster && overlayTitleActionWatched(item) && item.tmdbId != null
      ? batch?.getStatus(item.mediaType, item.tmdbId)?.watched
      : undefined;
  const watchMark = libraryWatchMark({
    ...item,
    watched: Boolean(item.watched) || Boolean(actionWatched),
  });
  const showProgressBar = progress > 0 && !isSeriesPoster;
  const showOverviewHover = !isBrowse && !isTouch;

  const openInspector = () => {
    onOpen?.(item);
  };

  const watchLabel =
    watchMark === 'unplayed'
      ? intl.formatMessage(messages.unwatched)
      : watchMark === 'watched'
        ? intl.formatMessage(messages.watched)
        : watchMark === 'partial' && item.unplayedItemCount
          ? intl.formatMessage(messages.remaining, {
              count: item.unplayedItemCount,
            })
          : watchMark === 'unavailable'
            ? intl.formatMessage(messages.unavailable)
            : progress > 0
              ? intl.formatMessage(messages.progress, {
                  percent: Math.round(progress),
                })
              : undefined;
  const posterLabel = [item.title, watchLabel].filter(Boolean).join(', ');

  return (
    <article
      data-testid="library-poster-card"
      data-surface={mode}
      data-watch-mark={watchMark}
      className={`group relative ${isBrowse ? 'w-full' : 'w-36 sm:w-36 md:w-44'}`}
    >
      <div className="relative aspect-[2/3] transform-gpu overflow-hidden rounded-xl bg-gray-800 shadow ring-1 ring-gray-700 transition duration-300 group-focus-within:ring-gray-500 group-hover:scale-105 group-hover:shadow-lg group-hover:ring-gray-500">
        <button
          type="button"
          onClick={openInspector}
          className="absolute inset-0 z-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
          aria-label={posterLabel}
          title={posterLabel}
        >
          {item.posterUrl ? (
            <CachedImage
              type="library"
              src={item.posterUrl}
              alt=""
              fill
              className={`object-cover ${
                watchMark === 'watched' ? 'opacity-70 saturate-50' : ''
              }`}
              sizes={isBrowse ? '160px' : '176px'}
            />
          ) : null}
        </button>
        {!isBrowse ? (
          <div
            className={`pointer-events-none absolute left-2 top-2 z-10 rounded-full border shadow-md ${
              item.mediaType === 'movie'
                ? 'border-blue-500 bg-blue-600/80'
                : isEpisodePoster
                  ? 'border-violet-500 bg-violet-600/80'
                  : 'border-purple-600 bg-purple-600/80'
            }`}
          >
            <div className="flex h-4 items-center px-2 py-2 text-center text-xs font-medium uppercase tracking-wider text-white sm:h-5">
              {typeLabel}
            </div>
          </div>
        ) : null}
        {watchMark === 'unplayed' ? (
          <span
            data-testid="library-unplayed-pip"
            className="pointer-events-none absolute right-2 top-2 z-10 h-3 w-3 rounded-full bg-emerald-400 shadow-md ring-2 ring-gray-900/80"
            aria-hidden
          />
        ) : null}
        {watchMark === 'watched' ? (
          <span
            data-testid="library-watched-mark"
            className="pointer-events-none absolute right-2 top-2 z-10 rounded-full bg-gray-900/80 p-0.5 shadow-md ring-1 ring-emerald-400/60"
            aria-hidden
          >
            <CheckBadgeIcon className="h-4 w-4 text-emerald-400 sm:h-5 sm:w-5" />
          </span>
        ) : null}
        {watchMark === 'partial' && item.unplayedItemCount ? (
          <span
            data-testid="library-remaining-count"
            className="pointer-events-none absolute right-2 top-2 z-10 inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-indigo-400 bg-indigo-600/80 px-1.5 text-xs font-semibold tabular-nums text-white shadow-md"
            aria-hidden
          >
            {item.unplayedItemCount}
          </span>
        ) : null}
        {showProgressBar ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 h-1 bg-black/70">
            <div
              className="h-full bg-indigo-500"
              style={{ width: `${Math.min(100, progress)}%` }}
            />
          </div>
        ) : null}
        {!isBrowse ? (
          <div
            className={`pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-gray-900 via-gray-900/70 to-transparent px-2 pb-2 pt-8 ${
              showOverviewHover
                ? 'transition-opacity group-focus-within:opacity-0 group-hover:opacity-0'
                : ''
            }`}
          >
            <h3 className="truncate text-sm font-semibold text-white">
              {item.title}
            </h3>
            {item.subtitle ? (
              <p className="truncate text-xs text-gray-300">{item.subtitle}</p>
            ) : null}
          </div>
        ) : null}
        {showOverviewHover ? (
          <div
            className="pointer-events-none absolute inset-0 z-20 flex flex-col justify-end p-2 opacity-0 transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
            style={{
              background:
                'linear-gradient(180deg, rgba(45, 55, 72, 0.4) 0%, rgba(45, 55, 72, 0.9) 100%)',
            }}
          >
            <button
              type="button"
              className="mb-2 w-full text-left text-white"
              onClick={openInspector}
            >
              {item.year ? (
                <div className="text-sm font-medium">{item.year}</div>
              ) : null}
              <h3
                className="whitespace-normal text-xl font-bold leading-tight"
                style={{
                  WebkitLineClamp: 2,
                  display: '-webkit-box',
                  overflow: 'hidden',
                  WebkitBoxOrient: 'vertical',
                  wordBreak: 'break-word',
                }}
              >
                {item.title}
              </h3>
              {item.subtitle ? (
                <p className="truncate text-xs text-gray-200">
                  {item.subtitle}
                </p>
              ) : null}
            </button>
            <Button
              as="a"
              href={item.mediaUrl}
              buttonType="primary"
              buttonSize="sm"
              className="w-full"
              data-testid="library-overview-play"
              onClick={(event) => {
                event.stopPropagation();
                if (!item.mediaUrl) {
                  event.preventDefault();
                }
                void playItem(event, item, onOpen);
              }}
            >
              <PlayIcon />
              <span>
                {intl.formatMessage(isResume ? messages.resume : messages.play)}
              </span>
            </Button>
          </div>
        ) : null}
      </div>
      {isBrowse ? (
        <button
          type="button"
          onClick={openInspector}
          className="mt-2 block min-h-11 w-full min-w-0 rounded text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          title={posterLabel}
        >
          <h3 className="line-clamp-2 min-h-10 text-sm font-semibold text-white">
            {item.title}
          </h3>
          <p className="truncate text-xs text-gray-400">
            {[item.year, typeLabel].filter(Boolean).join(' · ')}
          </p>
          {watchLabel ? (
            <p
              className={`mt-1 text-xs ${watchMark === 'watched' ? 'text-emerald-400' : watchMark === 'partial' || progress > 0 ? 'text-indigo-300' : 'text-gray-400'}`}
            >
              {watchLabel}
            </p>
          ) : null}
        </button>
      ) : null}
    </article>
  );
};

export default LibraryPosterCard;
