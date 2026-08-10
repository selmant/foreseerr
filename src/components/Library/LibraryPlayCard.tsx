import TitleCard from '@app/components/TitleCard';
import TmdbTitleCard from '@app/components/TitleCard/TmdbTitleCard';
import type { LibraryTitle } from '@server/interfaces/api/libraryInterfaces';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';

interface LibraryPlayCardProps {
  item: LibraryTitle;
  onOpenSeries?: (item: LibraryTitle) => void;
  onManage?: (title: MovieDetails | TvDetails) => void;
}

/**
 * Library shelf card: reuse Discover TitleCard posters/metadata when TMDB is known.
 * Falls back to a TitleCard shell with the placeholder poster when not.
 */
const LibraryPlayCard = ({
  item,
  onOpenSeries,
  onManage,
}: LibraryPlayCardProps) => {
  const openSeries =
    item.mediaType === 'tv' && (item.jellyfinSeriesId || item.jellyfinItemId)
      ? () =>
          onOpenSeries?.({
            ...item,
            jellyfinSeriesId: item.jellyfinSeriesId ?? item.jellyfinItemId,
          })
      : undefined;

  if (item.tmdbId) {
    return (
      <TmdbTitleCard
        id={item.mediaId ?? item.tmdbId}
        tmdbId={item.tmdbId}
        type={item.mediaType}
        libraryMode
        subtitle={item.subtitle}
        progressPercent={item.progressPercent}
        jellyfinItemId={item.jellyfinItemId}
        playItemId={item.playItemId}
        jellyfinSeriesId={item.jellyfinSeriesId}
        mediaUrl={item.mediaUrl}
        onLibraryOpenSeries={openSeries ? () => openSeries() : undefined}
        onLibraryManage={onManage}
      />
    );
  }

  return (
    <TitleCard
      id={0}
      title={item.title}
      summary={item.overview}
      mediaType={item.mediaType}
      status={item.status}
      libraryMode
      subtitle={item.subtitle}
      progressPercent={item.progressPercent}
      jellyfinItemId={item.jellyfinItemId}
      playItemId={item.playItemId}
      jellyfinSeriesId={item.jellyfinSeriesId}
      mediaUrl={item.mediaUrl}
      onLibraryOpenSeries={openSeries ? () => openSeries() : undefined}
    />
  );
};

export default LibraryPlayCard;
