import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import EmptyState from '@app/components/Common/EmptyState';
import LibraryPlayCard from '@app/components/Library/LibraryPlayCard';
import { libraryMediaActionRefs } from '@app/components/Library/libraryPosterWatchMark';
import { TitleCardBatchProvider } from '@app/components/TitleCard/TitleCardBatchContext';
import defineMessages from '@app/utils/defineMessages';
import { FunnelIcon } from '@heroicons/react/24/outline';
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
  const batchRefs = libraryMediaActionRefs(items);

  if (error) {
    return (
      <div aria-live="polite">
        <Alert type="error" title={intl.formatMessage(messages.loadFailed)} />
        <Button onClick={onRetry}>{intl.formatMessage(messages.retry)}</Button>
      </div>
    );
  }

  if (!loading && !items.length) {
    return (
      <div className="mt-6">
        <EmptyState
          icon={FunnelIcon}
          title={intl.formatMessage(messages.empty)}
        />
      </div>
    );
  }

  return (
    <TitleCardBatchProvider refs={batchRefs}>
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
                className="aspect-[2/3] animate-pulse rounded-xl bg-gray-700"
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
    </TitleCardBatchProvider>
  );
};

export default LibraryBrowseGrid;
