import type { DownloadingItem } from '@server/lib/downloadtracker';

type RequestDownloadScope =
  | { type: 'movie' }
  | {
      type: 'tv';
      seasons: { seasonNumber: number }[];
      episodes: { seasonNumber: number; episodeNumber: number }[];
    };

export const getRequestDownloadStatus = (
  downloadStatus: DownloadingItem[] | undefined,
  request: RequestDownloadScope
): DownloadingItem[] => {
  const items = downloadStatus ?? [];
  if (request.type === 'movie') {
    return items;
  }

  const seasons = new Set(request.seasons.map((season) => season.seasonNumber));
  const episodes = new Set(
    request.episodes.map(
      (episode) => `${episode.seasonNumber}:${episode.episodeNumber}`
    )
  );

  return items.filter(
    (item) =>
      item.episode &&
      (seasons.has(item.episode.seasonNumber) ||
        episodes.has(
          `${item.episode.seasonNumber}:${item.episode.episodeNumber}`
        ))
  );
};

export const refreshIntervalHelper = (
  downloadItem: {
    downloadStatus: DownloadingItem[] | undefined;
    downloadStatus4k: DownloadingItem[] | undefined;
  },
  timer: number
) => {
  if (
    (downloadItem.downloadStatus ?? []).length > 0 ||
    (downloadItem.downloadStatus4k ?? []).length > 0
  ) {
    return timer;
  } else {
    return 0;
  }
};
