import AnilistLogo from '@app/assets/services/anilist.svg';
import MdblistLogo from '@app/assets/services/mdblist.svg';
import PlexLogo from '@app/assets/services/plex.svg';
import TraktLogo from '@app/assets/services/trakt.svg';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';
import { EyeSlashIcon } from '@heroicons/react/24/solid';
import type { DiscoverItemSource } from '@server/interfaces/api/discoverInterfaces';
import type { ComponentType, SVGProps } from 'react';
import { useIntl } from 'react-intl';

const SOURCE_MARKS: Record<
  DiscoverItemSource,
  { Logo: ComponentType<SVGProps<SVGSVGElement>>; label: string }
> = {
  trakt: { Logo: TraktLogo, label: 'Trakt' },
  anilist: { Logo: AnilistLogo, label: 'AniList' },
  mdblist: { Logo: MdblistLogo, label: 'MDBList' },
  plex: { Logo: PlexLogo, label: 'Plex' },
};

const messages = defineMessages('components.TitleCard.UnmappedSourceCard', {
  unmapped: 'Couldn’t map to TMDB',
  notFoundOnTmdb: 'Not found on TMDB',
  openOriginal: 'Open original',
  hide: 'Hide',
});

export interface UnmappedSourceCardProps {
  title: string;
  type: 'movie' | 'tv';
  source: DiscoverItemSource;
  sourceUrl?: string;
  image?: string;
  hasTmdbId?: boolean;
  canExpand?: boolean;
  onHide: () => void;
}

const UnmappedSourceCard = ({
  title,
  type,
  source,
  sourceUrl,
  image,
  hasTmdbId = false,
  canExpand,
  onHide,
}: UnmappedSourceCardProps) => {
  const intl = useIntl();
  const { Logo, label } = SOURCE_MARKS[source];

  return (
    <div
      className={canExpand ? 'w-full' : 'w-36 sm:w-36 md:w-44'}
      data-testid="unmapped-title-card"
    >
      <div
        className="relative transform-gpu cursor-default overflow-hidden rounded-xl bg-gray-800 bg-cover shadow outline-none ring-1 ring-amber-700/70 transition duration-300"
        style={{
          paddingBottom: '150%',
        }}
      >
        <div className="absolute inset-0 h-full w-full overflow-hidden">
          {image ? (
            <CachedImage
              type="avatar"
              className="absolute inset-0 h-full w-full opacity-40"
              alt=""
              src={image}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              fill
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-b from-gray-800 to-gray-900" />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-gray-900 via-gray-900/70 to-transparent" />

          <div className="absolute left-0 right-0 flex items-center justify-between p-2">
            <div
              className={`z-40 rounded-full shadow ${
                type === 'movie' ? 'bg-blue-500' : 'bg-purple-600'
              }`}
            >
              <div className="flex h-4 items-center px-2 py-2 text-center text-xs font-medium uppercase tracking-wider text-white sm:h-5">
                {type === 'movie'
                  ? intl.formatMessage(globalMessages.movie)
                  : intl.formatMessage(globalMessages.tvshow)}
              </div>
            </div>
            <span
              className="z-40 inline-flex h-5 w-5 items-center justify-center"
              title={label}
              aria-label={label}
            >
              <Logo className="h-5 w-5" />
            </span>
          </div>

          <div className="flex h-full w-full items-end">
            <div className="px-2 pb-14 text-white">
              <h1
                className="whitespace-normal text-sm font-bold leading-tight sm:text-base"
                style={{
                  WebkitLineClamp: 3,
                  display: '-webkit-box',
                  overflow: 'hidden',
                  WebkitBoxOrient: 'vertical',
                  wordBreak: 'break-word',
                }}
                data-testid="title-card-title"
              >
                {title}
              </h1>
              <p className="mt-1 text-xs font-medium text-amber-300">
                {intl.formatMessage(
                  hasTmdbId ? messages.notFoundOnTmdb : messages.unmapped
                )}
              </p>
            </div>
          </div>

          <div className="absolute bottom-0 left-0 right-0 flex gap-1 px-2 py-2">
            {sourceUrl ? (
              <Button
                as="a"
                href={sourceUrl}
                target="_blank"
                rel="noreferrer"
                buttonType="ghost"
                buttonSize="sm"
                className="h-7 min-w-0 flex-1 px-2"
                title={intl.formatMessage(messages.openOriginal)}
              >
                <ArrowTopRightOnSquareIcon className="h-4 w-4" />
                <span className="truncate">
                  {intl.formatMessage(messages.openOriginal)}
                </span>
              </Button>
            ) : null}
            <Button
              buttonType="default"
              buttonSize="sm"
              className={sourceUrl ? 'h-7 px-2' : 'h-7 w-full'}
              onClick={(e) => {
                e.preventDefault();
                onHide();
              }}
            >
              <EyeSlashIcon className="h-4 w-4" />
              <span>{intl.formatMessage(messages.hide)}</span>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UnmappedSourceCard;
