import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import useLibraryPlay from '@app/components/Library/useLibraryPlay';
import defineMessages from '@app/utils/defineMessages';
import { EllipsisVerticalIcon } from '@heroicons/react/24/outline';
import type { LibraryTitle } from '@server/interfaces/api/libraryInterfaces';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Library.LibraryPosterCard', {
  play: 'Play',
  resume: 'Resume',
  viewDetails: 'View full details',
  manage: 'Manage',
  more: 'More actions',
  movie: 'Movie',
  series: 'Series',
});

interface LibraryPosterCardProps {
  item: LibraryTitle;
  compact?: boolean;
  onOpen?: (item: LibraryTitle) => void;
  onManage?: (title: MovieDetails | TvDetails) => void;
}

const LibraryPosterCard = ({
  item,
  compact = false,
  onOpen,
  onManage,
}: LibraryPosterCardProps) => {
  const intl = useIntl();
  const { playItem } = useLibraryPlay();
  const [menuOpen, setMenuOpen] = useState(false);
  const progress = item.progressPercent ?? 0;
  const isResume = progress > 0 && progress < 95;
  const detailsHref =
    item.tmdbId && item.mediaType === 'movie'
      ? `/movie/${item.tmdbId}`
      : item.tmdbId
        ? `/tv/${item.tmdbId}`
        : undefined;

  const openInspector = () => {
    onOpen?.(item);
  };

  const openManage = async () => {
    if (!item.tmdbId || !onManage) {
      return;
    }
    const { data } = await axios.get<MovieDetails | TvDetails>(
      `/api/v1/${item.mediaType}/${item.tmdbId}`
    );
    onManage(data);
  };

  return (
    <article
      data-testid="library-poster-card"
      className={`relative overflow-hidden rounded-lg bg-library-charcoal ring-1 ring-gray-800 ${
        compact ? 'w-full' : 'w-36 sm:w-44'
      }`}
    >
      <button
        type="button"
        onClick={openInspector}
        className="block w-full text-left"
        aria-label={item.title}
      >
        <div className="relative aspect-[2/3] bg-library-navy">
          {item.posterUrl ? (
            <CachedImage
              type="library"
              src={item.posterUrl}
              alt=""
              fill
              className="object-cover"
              sizes="176px"
            />
          ) : null}
          {progress > 0 ? (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-gray-800">
              <div
                className="h-full bg-indigo-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          ) : null}
        </div>
      </button>
      <div className="space-y-2 p-2">
        <h3 className="library-display truncate text-base font-semibold uppercase tracking-wide text-gray-100">
          {item.title}
        </h3>
        <p className="text-xs text-gray-400">
          {[
            item.year,
            item.mediaType === 'movie'
              ? intl.formatMessage(messages.movie)
              : intl.formatMessage(messages.series),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        <div className="flex items-center gap-1">
          <Button
            buttonType="primary"
            buttonSize="sm"
            className="min-h-11 min-w-11 flex-1"
            onClick={(event) => {
              void playItem(event, item, onOpen);
            }}
          >
            {intl.formatMessage(isResume ? messages.resume : messages.play)}
          </Button>
          <div className="relative">
            <button
              type="button"
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-gray-300 hover:bg-gray-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
              aria-label={intl.formatMessage(messages.more)}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <EllipsisVerticalIcon className="h-5 w-5" />
            </button>
            {menuOpen ? (
              <div className="absolute right-0 z-20 mt-1 w-44 rounded-md bg-gray-900 py-1 ring-1 ring-gray-700">
                {detailsHref ? (
                  <a
                    href={detailsHref}
                    className="block min-h-11 px-3 py-2 text-sm text-gray-200 hover:bg-gray-800"
                    onClick={() => setMenuOpen(false)}
                  >
                    {intl.formatMessage(messages.viewDetails)}
                  </a>
                ) : null}
                {item.mediaId && item.tmdbId ? (
                  <button
                    type="button"
                    className="block min-h-11 w-full px-3 py-2 text-left text-sm text-gray-200 hover:bg-gray-800"
                    onClick={() => {
                      setMenuOpen(false);
                      void openManage();
                    }}
                  >
                    {intl.formatMessage(messages.manage)}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </article>
  );
};

export default LibraryPosterCard;
