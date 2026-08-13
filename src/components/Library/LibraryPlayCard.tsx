import LibraryPosterCard from '@app/components/Library/LibraryPosterCard';
import LibraryResumeCard from '@app/components/Library/LibraryResumeCard';
import type { LibraryTitle } from '@server/interfaces/api/libraryInterfaces';

interface LibraryPlayCardProps {
  item: LibraryTitle;
  variant?: 'poster' | 'resume';
  compact?: boolean;
  surface?: 'overview' | 'browse';
  onOpen?: (item: LibraryTitle) => void;
}

const LibraryPlayCard = ({
  item,
  variant = 'poster',
  compact,
  surface,
  onOpen,
}: LibraryPlayCardProps) => {
  if (variant === 'resume') {
    return <LibraryResumeCard item={item} onOpen={onOpen} />;
  }
  return (
    <LibraryPosterCard
      item={item}
      compact={compact}
      surface={surface}
      onOpen={onOpen}
    />
  );
};

export default LibraryPlayCard;
