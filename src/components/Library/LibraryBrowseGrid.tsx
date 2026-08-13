import LibraryPlayCard from '@app/components/Library/LibraryPlayCard';
import defineMessages from '@app/utils/defineMessages';
import type { LibraryTitle } from '@server/interfaces/api/libraryInterfaces';
import type { LibraryDensity } from '@server/lib/libraryBrowseQuery';
import type { RefObject } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Library.LibraryBrowseGrid', {
  empty: 'No titles match these filters.',
  end: 'End of library.',
  retry: 'Retry',
  loadFailed: 'Could not load library titles.',
});

interface LibraryBrowseGridProps {
  items: LibraryTitle[];
  density: LibraryDensity;
  loading: boolean;
  error?: boolean;
  reachedEnd: boolean;
  onRetry: () => void;
  onOpen: (item: LibraryTitle) => void;
  sentinelRef: RefObject<HTMLDivElement | null>;
}

const LibraryBrowseGrid = ({
  items,
  density,
  loading,
  error,
  reachedEnd,
  onRetry,
  onOpen,
  sentinelRef,
}: LibraryBrowseGridProps) => {
  const intl = useIntl();
  const minWidth = density === 'compact' ? '7.5rem' : '10rem';

  if (error) {
    return (
      <div role="alert" aria-live="polite" className="space-y-3">
        <p className="text-sm text-red-400">
          {intl.formatMessage(messages.loadFailed)}
        </p>
        <button
          type="button"
          className="min-h-11 rounded-md bg-indigo-600 px-4 text-sm text-white"
          onClick={onRetry}
        >
          {intl.formatMessage(messages.retry)}
        </button>
      </div>
    );
  }

  if (!loading && !items.length) {
    return (
      <p className="text-sm text-gray-400">
        {intl.formatMessage(messages.empty)}
      </p>
    );
  }

  return (
    <>
      <div
        className={`grid ${density === 'compact' ? 'gap-2' : 'gap-4'}`}
        style={{
          gridTemplateColumns: `repeat(auto-fill, minmax(${minWidth}, 1fr))`,
        }}
      >
        {items.map((item) => (
          <LibraryPlayCard
            key={item.jellyfinItemId}
            item={item}
            compact
            surface="browse"
            onOpen={onOpen}
          />
        ))}
        {loading
          ? Array.from({ length: 8 }).map((_, index) => (
              <div
                key={`skeleton-${index}`}
                className="aspect-[2/3] animate-pulse rounded-lg bg-library-charcoal"
              />
            ))
          : null}
      </div>
      <div ref={sentinelRef} className="h-8" />
      {reachedEnd && items.length ? (
        <p className="mt-4 text-center text-sm text-gray-500">
          {intl.formatMessage(messages.end)}
        </p>
      ) : null}
    </>
  );
};

export default LibraryBrowseGrid;
