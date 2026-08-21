import TitleCard from '@app/components/TitleCard';
import UnmappedSourceCard from '@app/components/TitleCard/UnmappedSourceCard';
import {
  unmappedHideKey,
  useHiddenUnmappedTitles,
} from '@app/hooks/useHiddenUnmappedTitles';
import { Permission, useUser } from '@app/hooks/useUser';
import type { RatingResponse } from '@server/api/ratings';
import type {
  DiscoverItemSource,
  WatchlistItem,
} from '@server/interfaces/api/discoverInterfaces';
import { hasServarrMapping } from '@server/lib/servarrMapping';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import { useInView } from 'react-intersection-observer';
import useSWR from 'swr';

export interface TmdbTitleCardProps {
  id: number;
  tmdbId?: number;
  tvdbId?: number;
  type: 'movie' | 'tv';
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
  };
}

const isMovie = (movie: MovieDetails | TvDetails): movie is MovieDetails => {
  return (movie as MovieDetails).title !== undefined;
};

const hasTmdbId = (tmdbId?: number): tmdbId is number =>
  typeof tmdbId === 'number' && Number.isFinite(tmdbId) && tmdbId > 0;

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
}: TmdbTitleCardProps) => {
  const { hasPermission } = useUser();
  const { isHidden, hide, hideAllUnmapped } = useHiddenUnmappedTitles();
  const hideKey = unmappedHideKey(source, sourceId, ratingKey);
  const resolvedTmdbId = hasTmdbId(tmdbId) ? tmdbId : undefined;

  const { ref, inView } = useInView({
    triggerOnce: true,
  });
  const url = resolvedTmdbId
    ? type === 'movie'
      ? `/api/v1/movie/${resolvedTmdbId}`
      : `/api/v1/tv/${resolvedTmdbId}`
    : null;
  const { data: title, error } = useSWR<MovieDetails | TvDetails>(
    inView && url ? url : null
  );

  const showUnmapped =
    Boolean(source) && (!resolvedTmdbId || (Boolean(error) && !title));

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
        onHide={() => hide(hideKey)}
      />
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
          onHide={() => hide(hideKey)}
        />
      );
    }
    return hasPermission(Permission.ADMIN) ? (
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
