import TitleCard from '@app/components/TitleCard';
import TmdbTitleCard from '@app/components/TitleCard/TmdbTitleCard';
import type { LibraryTitle } from '@server/interfaces/api/libraryInterfaces';

interface LibraryPlayCardProps {
  item: LibraryTitle;
}

/**
 * Library shelf card: reuse Discover TitleCard posters/metadata when TMDB is known.
 * Falls back to a TitleCard shell with the placeholder poster when not.
 */
const LibraryPlayCard = ({ item }: LibraryPlayCardProps) => {
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
        mediaUrl={item.mediaUrl}
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
      mediaUrl={item.mediaUrl}
    />
  );
};

export default LibraryPlayCard;
