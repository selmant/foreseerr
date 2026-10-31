import defineMessages from '@app/utils/defineMessages';
import { MediaRequestStatus } from '@shared/constants/media';
import type EpisodeRequest from '@shared/entity/EpisodeRequest';
import type { IntlShape } from 'react-intl';

const messages = defineMessages('utils.episodeRequests', {
  watchAhead: 'Keep {count} Ahead',
  onward: '{episode} Onward',
});

const code = (episode: EpisodeRequest) =>
  `S${String(episode.seasonNumber).padStart(2, '0')}E${String(
    episode.episodeNumber
  ).padStart(2, '0')}`;

export const episodeRequestSummary = (
  intl: IntlShape,
  {
    episodes,
    type,
    watchAheadCount,
  }: {
    episodes: EpisodeRequest[];
    type?: 'single' | 'range' | 'after' | 'watchAhead';
    watchAheadCount?: number;
  }
): string => {
  if (type === 'watchAhead') {
    return intl.formatMessage(messages.watchAhead, {
      count: watchAheadCount ?? 10,
    });
  }
  if (!episodes.length) {
    return '';
  }
  if (type === 'after') {
    return intl.formatMessage(messages.onward, {
      episode: code(episodes[0]),
    });
  }
  if (episodes.length === 1) {
    return code(episodes[0]);
  }
  return `${code(episodes[0])}–${code(episodes[episodes.length - 1])}`;
};

/**
 * The status a requested episode shows. A failed, declined or completed
 * request speaks for all of its episodes, except an episode that failed on
 * its own: one the episode order the series uses in Sonarr leaves out
 * stays failed when the rest of the request completes.
 */
export const episodeRequestStatus = (
  requestStatus?: MediaRequestStatus,
  episodeStatus?: MediaRequestStatus
): MediaRequestStatus | undefined =>
  episodeStatus === MediaRequestStatus.FAILED
    ? episodeStatus
    : requestStatus === MediaRequestStatus.FAILED ||
        requestStatus === MediaRequestStatus.DECLINED ||
        requestStatus === MediaRequestStatus.COMPLETED
      ? requestStatus
      : episodeStatus;
