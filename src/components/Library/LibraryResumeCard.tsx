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
  progress: '{percent, number}% watched',
  openTitle: 'Open {title}',
  resumeTitle: 'Resume {title}{episode}',
  playTitle: 'Play {title}{episode}',
  minutesLeft: 'About {minutes, number} min left',
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
  const remainingMinutes =
    item.runtimeMinutes && progress > 0 && progress < 100
      ? Math.max(1, Math.ceil(item.runtimeMinutes * (1 - progress / 100)))
      : undefined;

  return (
    <article
      data-testid="library-resume-card"
      className="w-72 overflow-hidden rounded-xl bg-gray-800 shadow ring-1 ring-gray-700 transition duration-300 hover:shadow-lg hover:ring-gray-500 sm:w-80"
    >
      <button
        type="button"
        className="block w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
        onClick={() => onOpen?.(item)}
        aria-hidden
        tabIndex={-1}
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
        <h3 className="text-base font-bold text-white">
          <button
            type="button"
            className="flex min-h-[4.5rem] w-full flex-col justify-center rounded-md text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500"
            onClick={() => onOpen?.(item)}
            aria-label={intl.formatMessage(messages.openTitle, {
              title: item.title,
            })}
            title={item.title}
          >
            <span className="line-clamp-2 whitespace-normal">{item.title}</span>
            {item.subtitle && (
              <span className="mt-1 block w-full truncate text-sm font-normal text-gray-400">
                {item.subtitle}
              </span>
            )}
          </button>
        </h3>
        <div className="flex items-center justify-between gap-2">
          <Button
            as="a"
            href={item.mediaUrl}
            buttonType="primary"
            buttonSize="sm"
            className="min-h-11"
            data-testid="library-resume-play"
            aria-label={intl.formatMessage(
              progress > 0 ? messages.resumeTitle : messages.playTitle,
              {
                title: item.title,
                episode: item.subtitle ? ` · ${item.subtitle}` : '',
              }
            )}
            onClick={(event) => {
              if (!item.mediaUrl) {
                event.preventDefault();
              }
              void playItem(event, item, onOpen);
            }}
          >
            <PlayIcon />
            <span>
              {intl.formatMessage(
                progress > 0 ? messages.resume : messages.play
              )}
            </span>
          </Button>
          {progress > 0 ? (
            <span className="min-w-0 text-right text-xs leading-5 text-gray-400">
              {remainingMinutes && (
                <span className="block text-gray-300">
                  {intl.formatMessage(messages.minutesLeft, {
                    minutes: remainingMinutes,
                  })}
                </span>
              )}
              <span className="block">
                {intl.formatMessage(messages.progress, {
                  percent: Math.round(progress),
                })}
              </span>
            </span>
          ) : null}
        </div>
      </div>
    </article>
  );
};

export default LibraryResumeCard;
