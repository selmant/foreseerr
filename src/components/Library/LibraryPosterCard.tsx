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
import { CheckCircleIcon, PlayIcon } from '@heroicons/react/24/solid';
import type { LibraryTitle } from '@server/interfaces/api/libraryInterfaces';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Library.LibraryPosterCard', {
  play: 'Play',
  resume: 'Resume',
  movie: 'Movie',
  series: 'Series',
  episode: 'Episode',
  unwatchedRibbon: 'New',
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

  const posterLabel =
    watchMark === 'unplayed'
      ? `${item.title}, unwatched`
      : watchMark === 'watched'
        ? `${item.title}, watched`
        : watchMark === 'partial' && item.unplayedItemCount
          ? `${item.title}, ${item.unplayedItemCount} unwatched episodes`
          : watchMark === 'unavailable'
            ? `${item.title}, no episodes currently available`
            : item.title;

  return (
    <article
      data-testid="library-poster-card"
      data-surface={mode}
      data-watch-mark={watchMark}
      className={`group relative ${isBrowse ? 'w-full' : 'w-36 sm:w-44'}`}
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-library-navy ring-1 ring-gray-800">
        <button
          type="button"
          onClick={openInspector}
          className="absolute inset-0 z-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400"
          aria-label={posterLabel}
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
            className={`pointer-events-none absolute left-2 top-2 z-10 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white ${
              item.mediaType === 'movie'
                ? 'border-blue-500 bg-blue-600/80'
                : isEpisodePoster
                  ? 'border-violet-500 bg-violet-600/80'
                  : 'border-purple-600 bg-purple-600/80'
            }`}
          >
            {typeLabel}
          </div>
        ) : null}
        {watchMark === 'unplayed' ? (
          <span
            data-testid="library-unplayed-pip"
            className="pointer-events-none absolute -right-12 top-5 z-10 w-[9.5rem] rotate-45 bg-emerald-400 py-1 text-center text-[10px] font-extrabold uppercase tracking-[0.2em] text-gray-950 shadow"
            aria-hidden
          >
            {intl.formatMessage(messages.unwatchedRibbon)}
          </span>
        ) : null}
        {watchMark === 'watched' ? (
          <span
            data-testid="library-watched-mark"
            className="pointer-events-none absolute right-1.5 top-1.5 z-10 rounded-full bg-black/75 text-white shadow-md ring-1 ring-white/30"
            aria-hidden
          >
            <CheckCircleIcon className="h-5 w-5" />
          </span>
        ) : null}
        {watchMark === 'partial' && item.unplayedItemCount ? (
          <span
            data-testid="library-remaining-count"
            className="pointer-events-none absolute right-1.5 top-1.5 z-10 inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-indigo-500 px-1.5 text-[11px] font-bold tabular-nums text-white shadow-md"
            aria-hidden
          >
            {item.unplayedItemCount}
          </span>
        ) : null}
        {showProgressBar ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 h-1 bg-gray-800">
            <div
              className="h-full bg-indigo-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        ) : null}
        {!isBrowse ? (
          <div
            className={`pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/80 to-transparent p-2 ${
              showOverviewHover
                ? 'group-focus-within:opacity-0 group-hover:opacity-0'
                : ''
            }`}
          >
            <h3 className="library-display truncate text-sm font-semibold uppercase text-white">
              {item.title}
            </h3>
            {item.subtitle ? (
              <p className="truncate text-xs text-gray-200">{item.subtitle}</p>
            ) : null}
          </div>
        ) : null}
        {showOverviewHover ? (
          <div className="pointer-events-none absolute inset-0 z-20 flex flex-col justify-end bg-gradient-to-t from-black/90 via-black/45 to-transparent p-2 opacity-0 transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
            <button
              type="button"
              className="mb-2 w-full text-left text-white"
              onClick={openInspector}
            >
              {item.year ? (
                <div className="text-xs font-medium">{item.year}</div>
              ) : null}
              <h3 className="library-display line-clamp-2 text-base font-semibold uppercase leading-tight">
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
              <PlayIcon className="h-4 w-4" />
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
          className="mt-2 block w-full min-w-0 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
        >
          <h3 className="library-display truncate text-sm font-semibold uppercase tracking-wide text-gray-100">
            {item.title}
          </h3>
          <p className="truncate text-xs text-gray-400">
            {[item.year, typeLabel].filter(Boolean).join(' · ')}
          </p>
        </button>
      ) : null}
    </article>
  );
};

export default LibraryPosterCard;
