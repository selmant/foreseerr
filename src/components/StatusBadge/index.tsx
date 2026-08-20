import Spinner from '@app/assets/spinner.svg';
import Badge from '@app/components/Common/Badge';
import Tooltip from '@app/components/Common/Tooltip';
import DownloadBlock from '@app/components/DownloadBlock';
import ProgressBadge from '@app/components/StatusBadge/ProgressBadge';
import { useNativeRuntime } from '@app/context/NativeRuntimeContext';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { MediaStatus } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import type { DownloadingItem } from '@server/lib/downloadtracker';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.StatusBadge', {
  status: '{status}',
  status4k: '4K {status}',
  playonplex: 'Play on {mediaServerName}',
  openinarr: 'Open in {arr}',
  managemedia: 'Manage {mediaType}',
  seasonnumber: 'S{seasonNumber}',
  seasonepisodenumber: 'S{seasonNumber}E{episodeNumber}',
});

interface StatusBadgeProps {
  status?: MediaStatus;
  downloadItem?: DownloadingItem[];
  is4k?: boolean;
  inProgress?: boolean;
  plexUrl?: string;
  jellyfinItemId?: string | null;
  serviceUrl?: string;
  tmdbId?: number;
  mediaType?: 'movie' | 'tv';
  title?: string | string[];
  statusLabelOverride?: string;
}

const StatusBadge = ({
  status,
  downloadItem = [],
  is4k = false,
  inProgress = false,
  plexUrl,
  jellyfinItemId,
  serviceUrl,
  tmdbId,
  mediaType,
  title,
  statusLabelOverride,
}: StatusBadgeProps) => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const settings = useSettings();
  const { play } = useNativeRuntime();

  let mediaLink: string | undefined;
  let mediaLinkDescription: string | undefined;

  if (
    mediaType &&
    plexUrl &&
    hasPermission(
      is4k
        ? [
            Permission.REQUEST_4K,
            mediaType === 'movie'
              ? Permission.REQUEST_4K_MOVIE
              : Permission.REQUEST_4K_TV,
          ]
        : [
            Permission.REQUEST,
            mediaType === 'movie'
              ? Permission.REQUEST_MOVIE
              : Permission.REQUEST_TV,
          ],
      {
        type: 'or',
      }
    ) &&
    (!is4k ||
      (mediaType === 'movie'
        ? settings.currentSettings.movie4kEnabled
        : settings.currentSettings.series4kEnabled))
  ) {
    mediaLink = plexUrl;
    mediaLinkDescription = intl.formatMessage(messages.playonplex, {
      mediaServerName:
        settings.currentSettings.mediaServerType === MediaServerType.EMBY
          ? 'Emby'
          : settings.currentSettings.mediaServerType === MediaServerType.PLEX
            ? 'Plex'
            : 'Jellyfin',
    });
  } else if (hasPermission(Permission.MANAGE_REQUESTS)) {
    if (mediaType && tmdbId) {
      mediaLink = `/${mediaType}/${tmdbId}?manage=1`;
      mediaLinkDescription = intl.formatMessage(messages.managemedia, {
        mediaType: intl.formatMessage(
          mediaType === 'movie' ? globalMessages.movie : globalMessages.tvshow
        ),
      });
    } else if (hasPermission(Permission.ADMIN) && serviceUrl) {
      mediaLink = serviceUrl;
      mediaLinkDescription = intl.formatMessage(messages.openinarr, {
        arr: mediaType === 'movie' ? 'Radarr' : 'Sonarr',
      });
    }
  }

  const tooltipContent =
    mediaType === 'tv' &&
    downloadItem.length > 1 &&
    downloadItem.every(
      (item) =>
        item.downloadId && item.downloadId === downloadItem[0].downloadId
    ) ? (
      <DownloadBlock
        downloadItem={downloadItem[0]}
        title={Array.isArray(title) ? title[0] : title}
        is4k={is4k}
      />
    ) : (
      <ul>
        {downloadItem.map((status, index) => (
          <li
            key={`dl-status-${status.externalId}-${index}`}
            className="border-b border-gray-700 last:border-b-0"
          >
            <DownloadBlock
              downloadItem={status}
              title={Array.isArray(title) ? title[index] : title}
              is4k={is4k}
            />
          </li>
        ))}
      </ul>
    );

  const firstDownload = downloadItem[0];
  const groupedEpisodes =
    mediaType === 'tv' &&
    downloadItem.length > 1 &&
    downloadItem.every(
      (item) =>
        item.downloadId && item.downloadId === downloadItem[0]?.downloadId
    );
  const seasonLabel =
    firstDownload?.episode &&
    intl.formatMessage(messages.seasonnumber, {
      seasonNumber: firstDownload.episode.seasonNumber,
    });
  const episodeLabel =
    firstDownload?.episode &&
    intl.formatMessage(messages.seasonepisodenumber, {
      seasonNumber: firstDownload.episode.seasonNumber,
      episodeNumber: firstDownload.episode.episodeNumber,
    });
  const progressTooltip =
    mediaType === 'tv' && groupedEpisodes ? (
      <DownloadBlock
        downloadItem={downloadItem[0]}
        title={Array.isArray(title) ? title[0] : title}
        is4k={is4k}
      />
    ) : (
      <ul>
        {downloadItem.map((item, index) => (
          <li
            key={`dl-status-${item.externalId}-${index}`}
            className="border-b border-gray-700 last:border-b-0"
          >
            <DownloadBlock
              downloadItem={item}
              title={Array.isArray(title) ? title[index] : title}
              is4k={is4k}
            />
          </li>
        ))}
      </ul>
    );
  // Remaining non-available branches retain their existing markup until they
  // are migrated to ProgressBadge; keep this overlay centralized in the
  // coordinator for now rather than leaving an incomplete extraction.
  const badgeDownloadProgress = (
    <div
      className={`absolute left-0 top-0 z-10 flex h-full ${
        status === MediaStatus.DELETED
          ? 'bg-red-600/80'
          : status === MediaStatus.PROCESSING
            ? 'bg-indigo-500/80'
            : 'bg-green-500/80'
      } transition-all duration-200 ease-in-out`}
      style={{
        width: `${
          firstDownload
            ? Math.round(
                ((firstDownload.size - firstDownload.sizeLeft) /
                  firstDownload.size) *
                  100
              )
            : 0
        }%`,
      }}
    />
  );

  const downloadContext = inProgress &&
    mediaType === 'tv' &&
    firstDownload?.episode && (
      <>
        {groupedEpisodes ? (
          <span className="ml-1">
            {intl.formatMessage(messages.seasonnumber, {
              seasonNumber: firstDownload.episode.seasonNumber,
            })}
          </span>
        ) : (
          <span className="ml-1">
            {intl.formatMessage(messages.seasonepisodenumber, {
              seasonNumber: firstDownload.episode.seasonNumber,
              episodeNumber: firstDownload.episode.episodeNumber,
            })}
          </span>
        )}
        <Spinner className="ml-1 h-3 w-3" />
      </>
    );

  switch (status) {
    case MediaStatus.AVAILABLE:
      return (
        <ProgressBadge
          status={status}
          badgeType="success"
          statusText={intl.formatMessage(
            is4k ? messages.status4k : messages.status,
            {
              status: inProgress
                ? intl.formatMessage(globalMessages.processing)
                : intl.formatMessage(globalMessages.available),
            }
          )}
          inProgress={inProgress}
          mediaLink={mediaLink}
          mediaLinkDescription={mediaLinkDescription}
          tooltipContent={progressTooltip}
          downloadItem={downloadItem}
          mediaType={mediaType}
          seasonLabel={seasonLabel ?? ''}
          episodeLabel={episodeLabel ?? ''}
          onClick={(event) => {
            if (
              mediaLink &&
              jellyfinItemId &&
              play({
                provider: 'jellyfin',
                itemId: jellyfinItemId,
                fallbackUrl: mediaLink,
                label: mediaLinkDescription ?? 'Jellyfin',
                quality: is4k ? '4k' : 'standard',
              })
            ) {
              event.preventDefault();
            }
          }}
        />
      );

    case MediaStatus.PARTIALLY_AVAILABLE:
      return (
        <Tooltip
          content={inProgress ? tooltipContent : mediaLinkDescription}
          className={`${
            inProgress && 'hidden max-h-96 w-96 overflow-y-auto sm:block'
          }`}
          tooltipConfig={{
            ...(inProgress && { interactive: true, delayHide: 100 }),
          }}
        >
          <Badge
            badgeType="success"
            href={mediaLink}
            className={`${
              inProgress && 'relative !bg-gray-700/80 !px-0 hover:!bg-gray-700'
            } overflow-hidden`}
          >
            {inProgress && badgeDownloadProgress}
            <div
              className={`relative z-20 flex items-center ${
                inProgress && 'px-2'
              }`}
            >
              <span>
                {intl.formatMessage(
                  is4k ? messages.status4k : messages.status,
                  {
                    status: inProgress
                      ? intl.formatMessage(globalMessages.processing)
                      : intl.formatMessage(globalMessages.partiallyavailable),
                  }
                )}
              </span>
              {downloadContext}
            </div>
          </Badge>
        </Tooltip>
      );

    case MediaStatus.PROCESSING:
      return (
        <Tooltip
          content={inProgress ? tooltipContent : mediaLinkDescription}
          className={`${
            inProgress && 'hidden max-h-96 w-96 overflow-y-auto sm:block'
          }`}
          tooltipConfig={{
            ...(inProgress && { interactive: true, delayHide: 100 }),
          }}
        >
          <Badge
            badgeType="primary"
            href={mediaLink}
            className={`${
              inProgress && 'relative !bg-gray-700/80 !px-0 hover:!bg-gray-700'
            } overflow-hidden`}
          >
            {inProgress && badgeDownloadProgress}
            <div
              className={`relative z-20 flex items-center ${
                inProgress && 'px-2'
              }`}
            >
              <span>
                {intl.formatMessage(
                  is4k ? messages.status4k : messages.status,
                  {
                    status: inProgress
                      ? intl.formatMessage(globalMessages.processing)
                      : intl.formatMessage(globalMessages.requested),
                  }
                )}
              </span>
              {downloadContext}
            </div>
          </Badge>
        </Tooltip>
      );

    case MediaStatus.PENDING:
      return (
        <Tooltip content={mediaLinkDescription}>
          <Badge badgeType="warning" href={mediaLink}>
            {intl.formatMessage(is4k ? messages.status4k : messages.status, {
              status: intl.formatMessage(globalMessages.pending),
            })}
          </Badge>
        </Tooltip>
      );

    case MediaStatus.BLOCKLISTED:
      return (
        <Tooltip content={mediaLinkDescription}>
          <Badge badgeType="danger" href={mediaLink}>
            {intl.formatMessage(is4k ? messages.status4k : messages.status, {
              status:
                statusLabelOverride ??
                intl.formatMessage(globalMessages.blocklisted),
            })}
          </Badge>
        </Tooltip>
      );

    case MediaStatus.DELETED:
      return (
        <Tooltip
          content={inProgress ? tooltipContent : mediaLinkDescription}
          className={`${
            inProgress && 'hidden max-h-96 w-96 overflow-y-auto sm:block'
          }`}
          tooltipConfig={{
            ...(inProgress && { interactive: true, delayHide: 100 }),
          }}
        >
          <Badge
            badgeType="danger"
            href={mediaLink}
            className={`${
              inProgress && 'relative !bg-gray-700/80 !px-0 hover:!bg-gray-700'
            } overflow-hidden`}
          >
            {inProgress && badgeDownloadProgress}
            <div
              className={`relative z-20 flex items-center ${
                inProgress && 'px-2'
              }`}
            >
              <span>
                {intl.formatMessage(
                  is4k ? messages.status4k : messages.status,
                  {
                    status: inProgress
                      ? intl.formatMessage(globalMessages.processing)
                      : intl.formatMessage(globalMessages.deleted),
                  }
                )}
              </span>
              {downloadContext}
            </div>
          </Badge>
        </Tooltip>
      );

    default:
      return null;
  }
};

export default StatusBadge;
