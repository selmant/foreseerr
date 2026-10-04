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
import { useEffect, useRef, type RefObject } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Library.LibraryBrowseGrid', {
  empty: 'No titles match these filters.',
  emptyDescription:
    'Try a different search or remove some filters to find more titles.',
  emptyLibrary: 'Your library is empty',
  emptyLibraryDescription:
    'Movies and series available in Jellyfin will appear here.',
  reset: 'Reset search and filters',
  end: 'End of library.',
  retry: 'Retry',
  loadFailed: 'Could not load library titles.',
  loadedError:
    'Could not load library titles. Your loaded titles are still available.',
  loadMore: 'Load more titles',
  loadingMore: 'Loading titles…',
  loaded:
    '{shown, number} of {total, plural, one {# title loaded} other {# titles loaded}}',
});

interface LibraryBrowseGridProps {
  items: LibraryTitle[];
  density: LibraryDensity;
  loading: boolean;
  busy?: boolean;
  totalCount?: number;
  error?: boolean;
  reachedEnd: boolean;
  onRetry: () => void;
  onLoadMore: () => void;
  onOpen: (item: LibraryTitle) => void;
  hasFilters: boolean;
  onReset: () => void;
  sentinelRef: RefObject<HTMLDivElement | null>;
}

const LibraryBrowseGrid = ({
  items,
  density,
  loading,
  busy = loading,
  totalCount,
  error,
  reachedEnd,
  onRetry,
  onLoadMore,
  onOpen,
  hasFilters,
  onReset,
  sentinelRef,
}: LibraryBrowseGridProps) => {
  const intl = useIntl();
  const minWidth = density === 'compact' ? '7.5rem' : '10rem';
  const batchRefs = libraryMediaActionRefs(items);
  const gridRef = useRef<HTMLDivElement>(null);
  const loadButton = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<{
    count: number;
    button: HTMLButtonElement | null;
  } | null>(null);
  useEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || busy) return;
    if (items.length > pending.count) {
      if (
        document.activeElement === pending.button ||
        (!pending.button?.isConnected &&
          document.activeElement === document.body)
      ) {
        gridRef.current
          ?.querySelectorAll<HTMLElement>('[data-testid="library-poster-card"]')
          [pending.count]?.querySelector<HTMLButtonElement>('button')
          ?.focus();
      }
      pendingFocus.current = null;
    } else if (error) {
      if (
        document.activeElement === pending.button ||
        (!pending.button?.isConnected &&
          document.activeElement === document.body)
      ) {
        loadButton.current?.focus();
      }
      pendingFocus.current = null;
    }
  }, [busy, error, items.length]);
  const recovery = (
    <div className="space-y-3" aria-live="polite">
      <Alert
        type="error"
        title={intl.formatMessage(
          items.length ? messages.loadedError : messages.loadFailed
        )}
      />
      <Button
        ref={loadButton}
        type="button"
        className="min-h-11"
        aria-disabled={busy}
        aria-busy={busy}
        onClick={() => {
          if (busy) return;
          pendingFocus.current = {
            count: items.length,
            button: loadButton.current,
          };
          onRetry();
        }}
      >
        {intl.formatMessage(messages.retry)}
      </Button>
    </div>
  );

  if (error && !items.length) {
    return recovery;
  }

  if (!loading && !items.length) {
    return (
      <div className="mt-6">
        <EmptyState
          icon={FunnelIcon}
          title={intl.formatMessage(
            hasFilters ? messages.empty : messages.emptyLibrary
          )}
          description={intl.formatMessage(
            hasFilters
              ? messages.emptyDescription
              : messages.emptyLibraryDescription
          )}
          action={
            hasFilters ? (
              <Button
                buttonType="primary"
                className="min-h-11"
                onClick={onReset}
              >
                {intl.formatMessage(messages.reset)}
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  return (
    <TitleCardBatchProvider refs={batchRefs}>
      <div
        ref={gridRef}
        aria-busy={busy}
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
                className="aspect-[2/3] animate-pulse rounded-xl bg-gray-700 motion-reduce:animate-none"
              />
            ))
          : null}
      </div>
      <div ref={sentinelRef} className="h-8" aria-hidden />
      {items.length && totalCount != null ? (
        <p role="status" className="mb-3 text-center text-sm text-gray-400">
          {intl.formatMessage(messages.loaded, {
            shown: items.length,
            total: totalCount,
          })}
        </p>
      ) : null}
      {error ? (
        recovery
      ) : !reachedEnd ? (
        <div className="flex justify-center">
          <Button
            ref={loadButton}
            type="button"
            className="min-h-11"
            aria-disabled={busy}
            aria-busy={busy}
            onClick={() => {
              if (busy) return;
              pendingFocus.current = {
                count: items.length,
                button: loadButton.current,
              };
              onLoadMore();
            }}
          >
            {intl.formatMessage(
              loading ? messages.loadingMore : messages.loadMore
            )}
          </Button>
        </div>
      ) : null}
      {reachedEnd && !error && items.length ? (
        <p className="mt-4 text-center text-sm text-gray-500">
          {intl.formatMessage(messages.end)}
        </p>
      ) : null}
    </TitleCardBatchProvider>
  );
};

export default LibraryBrowseGrid;
