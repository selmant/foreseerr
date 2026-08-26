export type LibraryWatchMark =
  | 'unavailable'
  | 'unplayed'
  | 'watched'
  | 'progress'
  | 'partial';

export const isLibrarySeriesPoster = (item: {
  mediaType?: 'movie' | 'tv';
  jellyfinItemId?: string;
  jellyfinSeriesId?: string;
}): boolean =>
  item.mediaType === 'tv' &&
  Boolean(item.jellyfinSeriesId) &&
  item.jellyfinItemId === item.jellyfinSeriesId;

/** Episode row in a shelf (not the series shell). */
export const isLibraryEpisodePoster = (item: {
  mediaType?: 'movie' | 'tv';
  jellyfinItemId?: string;
  jellyfinSeriesId?: string;
}): boolean =>
  Boolean(item.jellyfinSeriesId) &&
  Boolean(item.jellyfinItemId) &&
  item.jellyfinItemId !== item.jellyfinSeriesId;

/**
 * Title-level Trakt/AniList watched is keyed by TMDB show/movie id.
 * Episode posters share the show's TMDB id, so overlaying that flag would
 * mark newly added episodes watched whenever any episode of the show is.
 */
export const overlayTitleActionWatched = (item: {
  mediaType?: 'movie' | 'tv';
  jellyfinItemId?: string;
  jellyfinSeriesId?: string;
}): boolean => item.mediaType === 'movie' && !isLibraryEpisodePoster(item);

export const libraryWatchMark = (item: {
  mediaType?: 'movie' | 'tv';
  jellyfinItemId?: string;
  jellyfinSeriesId?: string;
  watched?: boolean;
  inProgress?: boolean;
  progressPercent?: number;
  unplayedItemCount?: number;
  availableEpisodeCount?: number;
  lastPlayedAt?: string;
}): LibraryWatchMark => {
  if (isLibrarySeriesPoster(item)) {
    const available = item.availableEpisodeCount;
    const unplayed = item.unplayedItemCount;

    // A series shell can remain after its episodes are removed by another
    // application. It is not a completed series; there is simply nothing
    // currently available to play.
    if (available === 0) {
      return 'unavailable';
    }

    if (available != null && unplayed != null) {
      if (unplayed === 0) {
        return 'watched';
      }
      if (unplayed >= available) {
        return 'unplayed';
      }
      return 'partial';
    }

    // Older Jellyfin versions may omit aggregate counts. Do not let an
    // external show-level status turn a partially watched series into a
    // completed one in that case.
    if (item.watched) return 'watched';
    return 'unplayed';
  }

  const progress = item.progressPercent ?? 0;
  if (item.inProgress || (progress > 0 && progress < 95)) {
    return 'progress';
  }
  if (item.watched) {
    return 'watched';
  }
  return 'unplayed';
};

export const showLibraryUnplayedPip = (
  item: Parameters<typeof libraryWatchMark>[0]
): boolean => libraryWatchMark(item) === 'unplayed';

export const libraryMediaActionRefs = (
  items: {
    mediaType: 'movie' | 'tv';
    tmdbId?: number;
    title?: string;
    year?: number;
    jellyfinItemId?: string;
    jellyfinSeriesId?: string;
  }[]
) =>
  items.flatMap((item) => {
    if (!item.tmdbId) return [];
    // Episode rows share the show TMDB id; title-level watched/rating status
    // must not be batched for them (Recently Added Episodes slider).
    if (isLibraryEpisodePoster(item)) return [];
    return [
      {
        mediaType: item.mediaType,
        tmdbId: item.tmdbId,
        title: item.title,
        year: item.year,
      },
    ];
  });
