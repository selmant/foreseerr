import LibraryPosterCard from '@app/components/Library/LibraryPosterCard';
import LibraryResumeCard from '@app/components/Library/LibraryResumeCard';
import type { LibraryTitle } from '@server/interfaces/api/libraryInterfaces';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';

interface LibraryPlayCardProps {
  item: LibraryTitle;
  variant?: 'poster' | 'resume';
  compact?: boolean;
  onOpen?: (item: LibraryTitle) => void;
  onManage?: (title: MovieDetails | TvDetails) => void;
}

const LibraryPlayCard = ({
  item,
  variant = 'poster',
  compact,
  onOpen,
  onManage,
}: LibraryPlayCardProps) => {
  if (variant === 'resume') {
    return <LibraryResumeCard item={item} onOpen={onOpen} />;
  }
  return (
    <LibraryPosterCard
      item={item}
      compact={compact}
      onOpen={onOpen}
      onManage={onManage}
    />
  );
};

export default LibraryPlayCard;
