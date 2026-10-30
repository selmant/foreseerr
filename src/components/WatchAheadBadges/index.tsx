import Badge from '@app/components/Common/Badge';
import Tooltip from '@app/components/Common/Tooltip';
import defineMessages from '@app/utils/defineMessages';
import { MediaRequestStatus } from '@shared/constants/media';
import type EpisodeRequest from '@shared/entity/EpisodeRequest';
import type { MediaRequest } from '@shared/entity/MediaRequest';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.WatchAheadBadges', {
  removed: '{count} Removed',
  removedTip:
    '{count, plural, one {# episode} other {# episodes}} in the watch-ahead window {count, plural, one {was} other {were}} unmonitored in Sonarr before being downloaded, likely by a cleanup app. Foreseerr will not request {count, plural, one {it} other {them}} again.',
  inactive: 'Inactive',
  inactiveTip:
    'Every episode in the watch-ahead window was unmonitored in Sonarr before being downloaded, so this request is not fetching anything. Monitor them in Sonarr again if you still want them.',
});

export const removedEpisodes = (episodes?: EpisodeRequest[]) =>
  (episodes ?? []).filter((episode) => episode.unmonitoredAt);

export const RemovedEpisodesBadge = ({
  episodes,
  className,
}: {
  episodes?: EpisodeRequest[];
  className?: string;
}) => {
  const intl = useIntl();
  const count = removedEpisodes(episodes).length;

  if (count === 0) {
    return null;
  }

  return (
    <Tooltip content={intl.formatMessage(messages.removedTip, { count })}>
      <Badge badgeType="warning" className={className}>
        {intl.formatMessage(messages.removed, { count })}
      </Badge>
    </Tooltip>
  );
};

export const WatchAheadInactiveBadge = ({
  request,
  className,
}: {
  request: Pick<MediaRequest, 'status' | 'watchAheadInactiveAt'>;
  className?: string;
}) => {
  const intl = useIntl();

  if (
    request.status !== MediaRequestStatus.APPROVED ||
    !request.watchAheadInactiveAt
  ) {
    return null;
  }

  return (
    <Tooltip content={intl.formatMessage(messages.inactiveTip)}>
      <Badge badgeType="warning" className={className}>
        {intl.formatMessage(messages.inactive)}
      </Badge>
    </Tooltip>
  );
};
