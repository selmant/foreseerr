import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import EmptyState from '@app/components/Common/EmptyState';
import ListView from '@app/components/Common/ListView';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowPathIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useIntl } from 'react-intl';
import { Link } from 'react-router';

const messages = defineMessages('components.Discover.DiscoverProviderResults', {
  refresh: 'Refresh titles',
  refreshing: 'Refreshing…',
  loading: 'Loading titles…',
  shown: '{count, plural, one {# title shown} other {# titles shown}}',
  loadError: 'Could not load titles from {source}. Try again.',
  partialError:
    'Could not update titles from {source}. Your loaded titles are still here.',
  retry: 'Try again',
  empty: 'No titles to show',
  loadMore: 'Load more titles',
  end: 'You’ve reached the end of this list.',
  requestedHidden: 'Requested titles are hidden by your Discover preferences.',
  preferences: 'Discover preferences',
});

interface DiscoverProviderResultsProps {
  source: string;
  titles: WatchlistItem[];
  isLoadingInitialData: boolean;
  isLoadingMore: boolean;
  isEmpty: boolean;
  isReachingEnd: boolean;
  error?: unknown;
  fetchMore: () => void;
  onRefresh: () => void | Promise<unknown>;
  mutate?: () => void;
  emptyDescription: ReactNode;
  emptyAction?: ReactNode;
}

/** Provider lists keep navigation and loaded titles available during errors. */
const DiscoverProviderResults = ({
  source,
  titles,
  isLoadingInitialData,
  isLoadingMore,
  isEmpty,
  isReachingEnd,
  error,
  fetchMore,
  onRefresh,
  mutate,
  emptyDescription,
  emptyAction,
}: DiscoverProviderResultsProps) => {
  const intl = useIntl();
  const settings = useSettings();
  const [refreshing, setRefreshing] = useState(false);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const loadMoreButton = useRef<HTMLButtonElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const endMessage = useRef<HTMLParagraphElement>(null);
  const pendingLoadFocus = useRef(false);
  useEffect(() => {
    if (!isLoadingMore && pendingLoadFocus.current) {
      pendingLoadFocus.current = false;
      if (!loadMoreButton.current && document.activeElement === document.body) {
        (error ? retryButton.current : endMessage.current)?.focus({
          preventScroll: true,
        });
      }
    }
  }, [isLoadingMore, isReachingEnd, error]);
  const refresh = async () => {
    const restoreFocus =
      document.activeElement === refreshButton.current ||
      document.activeElement === retryButton.current;
    setRefreshing(true);
    try {
      await onRefresh();
    } catch {
      // SWR exposes the failure through `error`, including refresh failures.
    } finally {
      setRefreshing(false);
      requestAnimationFrame(() => {
        if (restoreFocus && document.activeElement === document.body) {
          refreshButton.current?.focus({ preventScroll: true });
        }
      });
    }
  };
  const busy = refreshing || isLoadingInitialData || isLoadingMore;

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <p role="status" className="text-sm text-gray-400">
          {intl.formatMessage(
            isLoadingInitialData ? messages.loading : messages.shown,
            { count: titles.length }
          )}
        </p>
        <Button
          ref={refreshButton}
          type="button"
          buttonType="ghost"
          className="min-h-[44px]"
          disabled={busy}
          aria-busy={refreshing}
          onClick={refresh}
        >
          <ArrowPathIcon aria-hidden="true" />
          <span>
            {intl.formatMessage(
              refreshing ? messages.refreshing : messages.refresh
            )}
          </span>
        </Button>
      </div>
      {settings.currentSettings.hideRequested && (
        <p className="-mt-3 mb-5 text-sm text-gray-400">
          {intl.formatMessage(messages.requestedHidden)}{' '}
          <Link
            to="/profile/settings/discover"
            className="inline-flex min-h-[44px] items-center rounded px-1 text-indigo-400 hover:text-indigo-300 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-400"
          >
            {intl.formatMessage(messages.preferences)}
          </Link>
        </p>
      )}
      {Boolean(error) && (
        <div role="alert" className="mb-5">
          <Alert
            type="warning"
            title={intl.formatMessage(
              titles.length ? messages.partialError : messages.loadError,
              { source }
            )}
          />
          <Button
            ref={retryButton}
            type="button"
            className="min-h-[44px]"
            disabled={busy}
            onClick={refresh}
          >
            {intl.formatMessage(messages.retry)}
          </Button>
        </div>
      )}
      {(!error || titles.length > 0) && (
        <ListView
          plexItems={titles}
          isEmpty={isEmpty}
          isLoading={
            isLoadingInitialData || (isLoadingMore && titles.length > 0)
          }
          isReachingEnd={isReachingEnd || Boolean(error)}
          onScrollBottom={fetchMore}
          mutateParent={mutate}
          emptyContent={
            <EmptyState
              icon={MagnifyingGlassIcon}
              title={intl.formatMessage(messages.empty)}
              description={emptyDescription}
              action={emptyAction}
            />
          }
        />
      )}
      {!isEmpty && !isLoadingInitialData && !error && (
        <div className="my-6 flex justify-center">
          {isReachingEnd ? (
            <p ref={endMessage} tabIndex={-1} className="text-sm text-gray-400">
              {intl.formatMessage(messages.end)}
            </p>
          ) : (
            <Button
              ref={loadMoreButton}
              type="button"
              buttonType="ghost"
              className={`min-h-[44px] ${busy ? 'cursor-wait opacity-50' : ''}`}
              aria-disabled={busy}
              aria-busy={isLoadingMore}
              onClick={() => {
                if (!busy) {
                  pendingLoadFocus.current =
                    document.activeElement === loadMoreButton.current;
                  fetchMore();
                }
              }}
            >
              {intl.formatMessage(
                isLoadingMore ? messages.loading : messages.loadMore
              )}
            </Button>
          )}
        </div>
      )}
    </>
  );
};

export default DiscoverProviderResults;
