import type EpisodeRequest from '@server/entity/EpisodeRequest';

const code = (episode: EpisodeRequest) =>
  `S${String(episode.seasonNumber).padStart(2, '0')}E${String(
    episode.episodeNumber
  ).padStart(2, '0')}`;

export const episodeRequestSummary = ({
  episodes,
  type,
}: {
  episodes: EpisodeRequest[];
  type?: 'single' | 'range' | 'after';
}): string => {
  if (!episodes.length) {
    return '';
  }
  if (type === 'after') {
    return `${code(episodes[0])} onward`;
  }
  if (episodes.length === 1) {
    return code(episodes[0]);
  }
  return `${code(episodes[0])}–${code(episodes[episodes.length - 1])}`;
};
