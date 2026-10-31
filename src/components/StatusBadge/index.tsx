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
import { downloadLabel, groupDownloads } from '@app/utils/downloadGroups';
import { MediaStatus } from '@shared/constants/media';
import { MediaServerType } from '@shared/constants/server';
import type { DownloadingItem } from '@shared/lib/downloadtracker';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.StatusBadge', {
  status: '{status}',
  status4k: '4K {status}',
  playonplex: 'Play on {mediaServerName}',
  openinarr: 'Open in {arr}',
  managemedia: 'Manage {mediaType}',
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

  // One entry per download: Sonarr lists a pack once per episode.
  const downloads = groupDownloads(downloadItem);
  const titleOf = (item: DownloadingItem) =>
    Array.isArray(title) ? title[downloadItem.indexOf(item)] : title;
  const tooltipContent = (
    <ul>
      {downloads.map((download, index) => (
        <li
          key={`dl-status-${download.item.externalId}-${index}`}
          className="border-b border-gray-700 last:border-b-0"
        >
          <DownloadBlock
            downloadItem={download.item}
            items={download.items}
            title={titleOf(download.item)}
            is4k={is4k}
          />
        </li>
      ))}
    </ul>
  );

  const firstDownload = downloadItem[0];
  // What the first download covers, e.g. `S01E02` or `S02 pack (10 eps)`.
  const firstLabel =
    mediaType === 'tv' && downloads[0]
      ? downloadLabel(intl, downloads[0].items)
      : undefined;
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

  const downloadContext = inProgress && firstLabel && (
    <>
      <span className="ml-1">{firstLabel}</span>
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
          tooltipContent={tooltipContent}
          downloadItem={downloadItem}
          downloadLabel={firstLabel}
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
