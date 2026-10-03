import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import useLibraryPlay from '@app/components/Library/useLibraryPlay';
import defineMessages from '@app/utils/defineMessages';
import { PlayIcon } from '@heroicons/react/24/solid';
import type { LibraryTitle } from '@server/interfaces/api/libraryInterfaces';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Library.LibraryResumeCard', {
  resume: 'Resume',
  play: 'Play',
});

interface LibraryResumeCardProps {
  item: LibraryTitle;
  onOpen?: (item: LibraryTitle) => void;
}

const LibraryResumeCard = ({ item, onOpen }: LibraryResumeCardProps) => {
  const intl = useIntl();
  const { playItem } = useLibraryPlay();
  const progress = item.progressPercent ?? 0;
  const artwork = item.backdropUrl || item.posterUrl;

  return (
    <article
      data-testid="library-resume-card"
      className="w-72 overflow-hidden rounded-xl bg-gray-800 shadow ring-1 ring-gray-700 transition duration-300 hover:shadow-lg hover:ring-gray-500 sm:w-80"
    >
      <button
        type="button"
        className="block w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
        onClick={() => onOpen?.(item)}
        aria-label={item.title}
      >
        <div className="relative aspect-video bg-gray-700">
          {artwork ? (
            <CachedImage
              type="library"
              src={artwork}
              alt=""
              fill
              className="object-cover"
              sizes="320px"
            />
          ) : null}
          <div className="absolute inset-0 bg-gradient-to-t from-gray-800 via-transparent to-transparent" />
          {progress > 0 ? (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-black/70">
              <div
                className="h-full bg-indigo-500"
                style={{ width: `${Math.min(100, progress)}%` }}
              />
            </div>
          ) : null}
        </div>
      </button>
      <div className="space-y-2 p-3">
        <h3 className="truncate text-base font-bold text-white">
          {item.title}
        </h3>
        {item.subtitle ? (
          <p className="truncate text-sm text-gray-400">{item.subtitle}</p>
        ) : null}
        <Button
          as="a"
          href={item.mediaUrl}
          buttonType="primary"
          buttonSize="sm"
          data-testid="library-resume-play"
          onClick={(event) => {
            if (!item.mediaUrl) {
              event.preventDefault();
            }
            void playItem(event, item, onOpen);
          }}
        >
          <PlayIcon />
          <span>
            {intl.formatMessage(progress > 0 ? messages.resume : messages.play)}
          </span>
        </Button>
      </div>
    </article>
  );
};

export default LibraryResumeCard;
