import TitleCard from '@app/components/TitleCard';
import { Permission, useUser } from '@app/hooks/useUser';
import type { RatingResponse } from '@server/api/ratings';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import { useInView } from 'react-intersection-observer';
import useSWR from 'swr';

export interface TmdbTitleCardProps {
  id: number;
  tmdbId: number;
  tvdbId?: number;
  type: 'movie' | 'tv';
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
}

const isMovie = (movie: MovieDetails | TvDetails): movie is MovieDetails => {
  return (movie as MovieDetails).title !== undefined;
};

const TmdbTitleCard = ({
  id,
  tmdbId,
  tvdbId,
  type,
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
}: TmdbTitleCardProps) => {
  const { hasPermission } = useUser();

  const { ref, inView } = useInView({
    triggerOnce: true,
  });
  const url =
    type === 'movie' ? `/api/v1/movie/${tmdbId}` : `/api/v1/tv/${tmdbId}`;
  const { data: title, error } = useSWR<MovieDetails | TvDetails>(
    inView ? `${url}` : null
  );

  if (!title && !error) {
    return (
      <div ref={ref}>
        <TitleCard.Placeholder canExpand={canExpand} />
      </div>
    );
  }

  if (!title) {
    return hasPermission(Permission.ADMIN) ? (
      <TitleCard.ErrorCard
        id={id}
        tmdbId={tmdbId}
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
