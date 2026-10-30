import TitleCard from '@app/components/TitleCard';
import UnmappedSourceCard from '@app/components/TitleCard/UnmappedSourceCard';
import {
  unmappedHideKey,
  useHiddenUnmappedTitles,
} from '@app/hooks/useHiddenUnmappedTitles';
import useSettings from '@app/hooks/useSettings';
import { Permission, useUser } from '@app/hooks/useUser';
import { rowCoversIdleRatingBadges } from '@app/utils/ratingBadges';
import type { RatingResponse } from '@shared/api/ratings';
import type {
  DiscoverItemSource,
  DiscoverMappingInfo,
  WatchlistItem,
  WatchlistItemMediaInfo,
} from '@shared/interfaces/api/discoverInterfaces';
import { hasServarrMapping } from '@shared/lib/servarrMapping';
import type { MovieDetails } from '@shared/models/Movie';
import type { TvDetails } from '@shared/models/Tv';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useInView } from 'react-intersection-observer';
import useSWR from 'swr';

export interface TmdbTitleCardProps {
  id: number;
  tmdbId?: number;
  tvdbId?: number;
  type?: 'movie' | 'tv';
  title?: string;
  canExpand?: boolean;
  isAddedToWatchlist?: boolean;
  mutateParent?: () => void;
  ratings?: RatingResponse | null;
  libraryMode?: boolean;
  subtitle?: string;
  progressPercent?: number;
  jellyfinItemId?: string | null;
  playItemId?: string | null;
  jellyfinSeriesId?: string | null;
  mediaUrl?: string | null;
  onLibraryOpenSeries?: (jellyfinSeriesId: string) => void;
  onLibraryManage?: (title: MovieDetails | TvDetails) => void;
  source?: DiscoverItemSource;
  sourceUrl?: string;
  sourceId?: string;
  sourceImage?: string;
  ratingKey?: string;
  mappingState?: DiscoverMappingInfo;
  /**
   * Row payload from a provider list. With a TMDB poster the card paints from
   * these and loads `/movie/:id` or `/tv/:id` once its details are opened, or
   * as it scrolls into view when the row lacks what the idle badges show.
   */
  posterPath?: string;
  releaseDate?: string;
  firstAirDate?: string;
  voteAverage?: number;
  mediaInfo?: WatchlistItemMediaInfo;
}

export function watchlistTitleCardProps(
  item: WatchlistItem
): Pick<
  TmdbTitleCardProps,
  | 'id'
  | 'tmdbId'
  | 'type'
  | 'title'
  | 'ratings'
  | 'source'
  | 'sourceUrl'
  | 'sourceId'
  | 'sourceImage'
  | 'ratingKey'
  | 'mappingState'
  | 'posterPath'
  | 'releaseDate'
  | 'firstAirDate'
  | 'voteAverage'
  | 'mediaInfo'
> {
  return {
    id: item.tmdbId ?? item.id ?? 0,
    tmdbId: item.tmdbId,
    type: item.mediaType,
    title: item.title,
    ratings: item.ratings,
    source: item.source,
    sourceUrl: item.sourceUrl,
    sourceId: item.sourceId,
    sourceImage: item.image,
    ratingKey: item.ratingKey,
    mappingState: item.mappingState,
    posterPath: item.posterPath,
    releaseDate: item.releaseDate,
    firstAirDate: item.firstAirDate,
    voteAverage: item.voteAverage,
    mediaInfo: item.mediaInfo,
  };
}

const isMovie = (movie: MovieDetails | TvDetails): movie is MovieDetails => {
  return (movie as MovieDetails).title !== undefined;
};

const hasTmdbId = (tmdbId?: number): tmdbId is number =>
  typeof tmdbId === 'number' && Number.isFinite(tmdbId) && tmdbId > 0;

/** Bare TMDB path (`/abc.jpg`), which the server only sends for a confirmed id. */
const tmdbPosterPath = (posterPath?: string): string | undefined =>
  posterPath?.startsWith('/') ? posterPath : undefined;

/** Brief hover intent, so sweeping the pointer across a row loads nothing. */
const DETAILS_FETCH_DELAY_MS = 150;

const TmdbTitleCard = ({
  id,
  tmdbId,
  tvdbId,
  type,
  title: originalTitle,
  canExpand,
  isAddedToWatchlist = false,
  mutateParent,
  ratings,
  libraryMode = false,
  subtitle,
  progressPercent,
  jellyfinItemId,
  playItemId,
  jellyfinSeriesId,
  mediaUrl,
  onLibraryOpenSeries,
  onLibraryManage,
  source,
  sourceUrl,
  sourceId,
  sourceImage,
  ratingKey,
  mappingState,
  posterPath,
  releaseDate,
  firstAirDate,
  voteAverage,
  mediaInfo,
}: TmdbTitleCardProps) => {
  const { hasPermission } = useUser();
  const { currentSettings } = useSettings();
  const { isHidden, hide, hideAllUnmapped } = useHiddenUnmappedTitles();
  const hideKey = unmappedHideKey(source, sourceId, ratingKey);
  const resolvedTmdbId = hasTmdbId(tmdbId) ? tmdbId : undefined;
  const rowPosterPath = tmdbPosterPath(posterPath);
  // The row carries everything the closed card shows, so details only add
  // the overview of the open card. A row without the score or ratings the
  // idle badges show still paints at once, but gets its details as it scrolls
  // into view: hovering must not be what makes a poster's ratings appear.
  const paintFromRow = Boolean(
    resolvedTmdbId && type && originalTitle && rowPosterPath && !libraryMode
  );
  const detailsOnView =
    !paintFromRow ||
    !rowCoversIdleRatingBadges(
      { tmdbRating: voteAverage, ratings },
      currentSettings.ratingBadges,
      currentSettings.mdblistConfigured
    );

  const { ref, inView } = useInView({
    triggerOnce: true,
    skip: !detailsOnView,
  });
  const [detailsWanted, setDetailsWanted] = useState(false);
  const detailsTimer = useRef<number | undefined>(undefined);
  const onShowDetailChange = useCallback((shown: boolean) => {
    window.clearTimeout(detailsTimer.current);
    if (shown) {
      detailsTimer.current = window.setTimeout(
        () => setDetailsWanted(true),
        DETAILS_FETCH_DELAY_MS
      );
    }
  }, []);
  useEffect(() => () => window.clearTimeout(detailsTimer.current), []);

  const url = resolvedTmdbId
    ? type === 'movie'
      ? `/api/v1/movie/${resolvedTmdbId}`
      : `/api/v1/tv/${resolvedTmdbId}`
    : null;
  const { data: title, error } = useSWR<MovieDetails | TvDetails>(
    (detailsWanted || (detailsOnView && inView)) && url ? url : null
  );

  const showUnmapped =
    Boolean(source) &&
    (!resolvedTmdbId || (!paintFromRow && Boolean(error) && !title));

  if (showUnmapped && (hideAllUnmapped || isHidden(hideKey))) {
    return null;
  }

  if (source && !resolvedTmdbId) {
    return (
      <UnmappedSourceCard
        title={originalTitle || ''}
        type={type}
        source={source}
        sourceUrl={sourceUrl}
        image={sourceImage}
        canExpand={canExpand}
        mappingState={mappingState}
        onHide={() => hide(hideKey)}
      />
    );
  }

  if (paintFromRow && resolvedTmdbId && type) {
    // A failed details load leaves the confirmed tile as it is, without the
    // overview, rather than turning it into an unmapped card on hover. The
    // row title stays the label after details load: a provider title (AniList,
    // Trakt, ...) can differ from the TMDB one, and the card must not rename
    // itself on hover.
    return (
      <div ref={ref}>
        <TitleCard
          id={resolvedTmdbId}
          isAddedToWatchlist={
            title?.mediaInfo?.watchlists?.length || isAddedToWatchlist
          }
          image={rowPosterPath}
          status={title?.mediaInfo?.status ?? mediaInfo?.status}
          summary={title?.overview}
          title={originalTitle ?? ''}
          userScore={title?.voteAverage ?? voteAverage}
          ratings={ratings ?? title?.ratings}
          year={
            (type === 'movie' ? releaseDate : firstAirDate) ??
            (title
              ? isMovie(title)
                ? title.releaseDate
                : title.firstAirDate
              : undefined)
          }
          mediaType={type}
          canExpand={canExpand}
          mutateParent={mutateParent}
          onShowDetailChange={onShowDetailChange}
        />
      </div>
    );
  }

  if (!title && !error) {
    return (
      <div ref={ref}>
        <TitleCard.Placeholder canExpand={canExpand} />
      </div>
    );
  }

  if (!title) {
    if (source) {
      return (
        <UnmappedSourceCard
          title={originalTitle || ''}
          type={type}
          source={source}
          sourceUrl={sourceUrl}
          image={sourceImage}
          hasTmdbId
          canExpand={canExpand}
          mappingState={mappingState}
          onHide={() => hide(hideKey)}
        />
      );
    }
    return hasPermission(Permission.ADMIN) && type ? (
      <TitleCard.ErrorCard
        id={id}
        tmdbId={resolvedTmdbId ?? 0}
        tvdbId={tvdbId}
        type={type}
      />
    ) : null;
  }

  const libraryProps = libraryMode
    ? {
        libraryMode: true as const,
        subtitle,
        progressPercent,
        jellyfinItemId:
          jellyfinItemId ??
          title.mediaInfo?.jellyfinMediaId ??
          title.mediaInfo?.jellyfinMediaId4k,
        playItemId,
        jellyfinSeriesId:
          jellyfinSeriesId ??
          (type === 'tv'
            ? (title.mediaInfo?.jellyfinMediaId ??
              title.mediaInfo?.jellyfinMediaId4k)
            : undefined),
        mediaUrl:
          mediaUrl ?? title.mediaInfo?.mediaUrl ?? title.mediaInfo?.mediaUrl4k,
        onLibraryOpenSeries,
        onLibraryManage:
          hasPermission(Permission.MANAGE_REQUESTS) &&
          hasServarrMapping(title.mediaInfo)
            ? () => onLibraryManage?.(title)
            : undefined,
      }
    : {};

  return isMovie(title) ? (
    <TitleCard
      key={title.id}
      id={title.id}
      isAddedToWatchlist={
        title.mediaInfo?.watchlists?.length || isAddedToWatchlist
      }
      image={title.posterPath}
      status={title.mediaInfo?.status}
      summary={title.overview}
      title={title.title}
      userScore={title.voteAverage}
      ratings={ratings ?? title.ratings}
      year={title.releaseDate}
      mediaType={'movie'}
      canExpand={canExpand}
      mutateParent={mutateParent}
      {...libraryProps}
    />
  ) : (
    <TitleCard
      key={title.id}
      id={title.id}
      isAddedToWatchlist={
        title.mediaInfo?.watchlists?.length || isAddedToWatchlist
      }
      image={title.posterPath}
      status={title.mediaInfo?.status}
      summary={title.overview}
      title={title.name}
      userScore={title.voteAverage}
      ratings={ratings ?? title.ratings}
      year={title.firstAirDate}
      mediaType={'tv'}
      canExpand={canExpand}
      mutateParent={mutateParent}
      {...libraryProps}
    />
  );
};

export default TmdbTitleCard;
