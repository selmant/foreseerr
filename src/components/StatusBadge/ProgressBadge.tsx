import Spinner from '@app/assets/spinner.svg';
import Badge from '@app/components/Common/Badge';
import Tooltip from '@app/components/Common/Tooltip';
import { MediaStatus } from '@shared/constants/media';
import type { DownloadingItem } from '@shared/lib/downloadtracker';
import type { ReactNode } from 'react';

interface ProgressBadgeProps {
  status: MediaStatus;
  badgeType: 'danger' | 'primary' | 'success';
  statusText: string;
  inProgress: boolean;
  mediaLink?: string;
  mediaLinkDescription?: string;
  tooltipContent: ReactNode;
  downloadItem: DownloadingItem[];
  /** What the first download covers, e.g. `S02 pack (10 eps)`. */
  downloadLabel?: string;
  onClick?: React.MouseEventHandler<HTMLElement>;
}

const calculateDownloadProgress = (media: DownloadingItem) =>
  Math.round(((media?.size - media?.sizeLeft) / media?.size) * 100);

const ProgressBadge = ({
  status,
  badgeType,
  statusText,
  inProgress,
  mediaLink,
  mediaLinkDescription,
  tooltipContent,
  downloadItem,
  downloadLabel,
  onClick,
}: ProgressBadgeProps) => {
  const firstDownload = downloadItem[0];
  const progressClass =
    status === MediaStatus.DELETED
      ? 'bg-red-600/80'
      : status === MediaStatus.PROCESSING
        ? 'bg-indigo-500/80'
        : 'bg-green-500/80';

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
        badgeType={badgeType}
        href={mediaLink}
        onClick={onClick}
        className={`${
          inProgress && 'relative !bg-gray-700/80 !px-0 hover:!bg-gray-700'
        } overflow-hidden`}
      >
        {inProgress && (
          <div
            className={`absolute left-0 top-0 z-10 flex h-full ${progressClass} transition-all duration-200 ease-in-out`}
            style={{
              width: `${firstDownload ? calculateDownloadProgress(firstDownload) : 0}%`,
            }}
          />
        )}
        <div
          className={`relative z-20 flex items-center ${inProgress && 'px-2'}`}
        >
          <span>{statusText}</span>
          {inProgress && downloadLabel && (
            <span className="ml-1">{downloadLabel}</span>
          )}
          {inProgress && <Spinner className="ml-1 h-3 w-3" />}
        </div>
      </Badge>
    </Tooltip>
  );
};

export default ProgressBadge;
