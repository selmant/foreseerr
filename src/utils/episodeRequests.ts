import defineMessages from '@app/utils/defineMessages';
import type EpisodeRequest from '@server/entity/EpisodeRequest';
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
