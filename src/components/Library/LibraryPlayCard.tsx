import CachedImage from '@app/components/Common/CachedImage';
import { useNativeRuntime } from '@app/context/NativeRuntimeContext';
import defineMessages from '@app/utils/defineMessages';
import { PlayIcon } from '@heroicons/react/24/solid';
import type { LibraryTitle } from '@server/interfaces/api/libraryInterfaces';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import Link from 'next/link';
import { useInView } from 'react-intersection-observer';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Library.LibraryPlayCard', {
  play: 'Play',
  openInJellyfin: 'Open in Jellyfin',
});

interface LibraryPlayCardProps {
  item: LibraryTitle;
}

const LibraryPlayCard = ({ item }: LibraryPlayCardProps) => {
  const intl = useIntl();
  const { play } = useNativeRuntime();
  const { ref, inView } = useInView({ triggerOnce: true });

  const detailUrl = item.tmdbId
    ? item.mediaType === 'movie'
      ? `/api/v1/movie/${item.tmdbId}`
      : `/api/v1/tv/${item.tmdbId}`
    : null;
  const { data: details } = useSWR<MovieDetails | TvDetails>(
    inView && detailUrl ? detailUrl : null
  );

  const posterPath =
    details && 'posterPath' in details ? details.posterPath : undefined;
  const displayTitle =
    details && 'title' in details
      ? details.title
      : details && 'name' in details
        ? details.name
        : item.title;
  const href = item.tmdbId
    ? `/${item.mediaType}/${item.tmdbId}`
    : item.mediaUrl;
  const fallbackUrl = item.mediaUrl ?? href ?? '#';

  const onPlay = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (
      play({
        provider: 'jellyfin',
        itemId: item.jellyfinItemId,
        fallbackUrl,
        label: displayTitle,
        quality: 'standard',
      })
    ) {
      return;
    }
    if (item.mediaUrl) {
      window.open(item.mediaUrl, '_blank', 'noopener,noreferrer');
    }
  };

  const cardInner = (
    <>
      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-lg bg-gray-800">
        {posterPath ? (
          <CachedImage
            src={posterPath}
            type="tmdb"
            alt=""
            fill
            sizes="160px"
            className="object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center px-2 text-center text-sm text-gray-400">
            {displayTitle}
          </div>
        )}
        <button
          type="button"
          onClick={onPlay}
          className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition hover:bg-black/50 hover:opacity-100 focus:bg-black/50 focus:opacity-100"
          aria-label={intl.formatMessage(messages.play)}
        >
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-600 text-white shadow-lg">
            <PlayIcon className="h-6 w-6" />
          </span>
        </button>
        {item.progressPercent != null && item.progressPercent > 0 ? (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-gray-900/80">
            <div
              className="h-full bg-indigo-500"
              style={{ width: `${item.progressPercent}%` }}
            />
          </div>
        ) : null}
      </div>
      <div className="mt-2 min-w-0">
        <p className="truncate text-sm font-semibold text-gray-100">
          {displayTitle}
        </p>
        {item.subtitle ? (
          <p className="truncate text-xs text-gray-400">{item.subtitle}</p>
        ) : null}
      </div>
    </>
  );

  return (
    <div ref={ref} className="w-36 flex-none sm:w-40">
      {href ? (
        <Link href={href} className="block outline-none">
          {cardInner}
        </Link>
      ) : (
        <div>{cardInner}</div>
      )}
    </div>
  );
};

export default LibraryPlayCard;
