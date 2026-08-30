import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import useLibraryPlay from '@app/components/Library/useLibraryPlay';
import TvFocusable from '@app/components/Tv/TvFocusable';
import { useNativeRuntime } from '@app/context/NativeRuntimeContext';
import defineMessages from '@app/utils/defineMessages';
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
  const { isTvShell } = useNativeRuntime();
  const { playItem } = useLibraryPlay();
  const progress = item.progressPercent ?? 0;
  const artwork = item.backdropUrl || item.posterUrl;

  const handlePlay = (event: { preventDefault: () => void }) => {
    if (!item.mediaUrl) {
      event.preventDefault();
    }
    void playItem(event, item, onOpen);
  };

  return (
    <TvFocusable
      onEnterPress={() => {
        handlePlay({ preventDefault: () => undefined });
      }}
    >
      {({ ref, className }) => (
        <article
          ref={ref}
          data-testid="library-resume-card"
          className={`w-72 overflow-hidden rounded-lg bg-library-charcoal ring-1 ring-gray-800 sm:w-80 ${className}`}
          tabIndex={isTvShell ? -1 : undefined}
        >
          <button
            type="button"
            className="block w-full text-left"
            onClick={() => onOpen?.(item)}
            aria-label={item.title}
          >
            <div className="relative aspect-video bg-library-navy">
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
              <div className="absolute inset-0 bg-gradient-to-t from-library-charcoal via-transparent to-transparent" />
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
          <div className="space-y-2 p-3">
            <h3 className="library-display truncate text-lg font-semibold uppercase tracking-wide text-white">
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
              className="min-h-11"
              data-testid="library-resume-play"
              onClick={(event) => {
                handlePlay(event);
              }}
            >
              {intl.formatMessage(
                progress > 0 ? messages.resume : messages.play
              )}
            </Button>
          </div>
        </article>
      )}
    </TvFocusable>
  );
};

export default LibraryResumeCard;
