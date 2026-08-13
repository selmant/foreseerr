import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import { showLibraryUnplayedPip } from '@app/components/Library/libraryPosterWatchMark';
import useLibraryPlay from '@app/components/Library/useLibraryPlay';
import { useIsTouch } from '@app/hooks/useIsTouch';
import defineMessages from '@app/utils/defineMessages';
import { PlayIcon } from '@heroicons/react/24/solid';
import type { LibraryTitle } from '@server/interfaces/api/libraryInterfaces';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Library.LibraryPosterCard', {
  play: 'Play',
  resume: 'Resume',
  movie: 'Movie',
  series: 'Series',
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
  const mode = surface ?? (compact ? 'browse' : 'overview');
  const isBrowse = mode === 'browse';
  const progress = item.progressPercent ?? 0;
  const isResume = progress > 0 && progress < 95;
  const typeLabel = intl.formatMessage(
    item.mediaType === 'movie' ? messages.movie : messages.series
  );
  const showOverviewHover = !isBrowse && !isTouch;

  const openInspector = () => {
    onOpen?.(item);
  };

  return (
    <article
      data-testid="library-poster-card"
      data-surface={mode}
      className={`group relative ${isBrowse ? 'w-full' : 'w-36 sm:w-44'}`}
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-xl bg-library-navy ring-1 ring-gray-800">
        <button
          type="button"
          onClick={openInspector}
          className="absolute inset-0 z-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-400"
          aria-label={
            showLibraryUnplayedPip(item)
              ? `${item.title}, unwatched`
              : item.title
          }
        >
          {item.posterUrl ? (
            <CachedImage
              type="library"
              src={item.posterUrl}
              alt=""
              fill
              className="object-cover"
              sizes={isBrowse ? '160px' : '176px'}
            />
          ) : null}
        </button>
        {!isBrowse ? (
          <div
            className={`pointer-events-none absolute left-2 top-2 z-10 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-white ${
              item.mediaType === 'movie'
                ? 'border-blue-500 bg-blue-600/80'
                : 'border-purple-600 bg-purple-600/80'
            }`}
          >
            {typeLabel}
          </div>
        ) : null}
        {showLibraryUnplayedPip(item) ? (
          <span
            data-testid="library-unplayed-pip"
            className="pointer-events-none absolute right-2 top-2 z-10 h-2.5 w-2.5 rounded-full bg-indigo-400 shadow ring-2 ring-black/40"
            aria-hidden
          />
        ) : null}
        {progress > 0 ? (
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
              buttonType="primary"
              buttonSize="sm"
              className="w-full"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
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
