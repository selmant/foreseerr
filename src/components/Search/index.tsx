import Button from '@app/components/Common/Button';
import EmptyState from '@app/components/Common/EmptyState';
import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import useDiscover from '@app/hooks/useDiscover';
import useRouteQuery from '@app/hooks/useRouteQuery';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowPathIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline';
import { MediaStatus } from '@server/constants/media';
import type {
  MovieResult,
  PersonResult,
  TvResult,
} from '@server/models/Search';
import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Search', {
  search: 'Search',
  searchresults: 'Search Results',
  queryContext: 'Results for “{query}”',
  resultsLoaded:
    '{count, plural, one {# result loaded} other {# results loaded}}',
  refreshResults: 'Refresh results',
  refreshingResults: 'Refreshing results…',
  loadMore: 'Load more results',
  loadingMore: 'Loading more results…',
  searching: 'Searching…',
  endOfResults: 'End of results',
  retry: 'Try again',
  loadError: 'Could not load search results. Try again.',
  savedResultsError:
    'Could not update your results. Previously loaded results are still available.',
  noResults: 'Nothing found for “{query}”',
  noResultsDescription:
    'Try a shorter search or check the spelling. You can search for movies, series, and people.',
  editSearch: 'Edit search',
  startSearch: 'Start searching',
  findTitle: 'Find a movie, series, or person',
  searchHint: 'Enter a title or a name in the search field above.',
});

const Search = () => {
  const intl = useIntl();
  const query = useRouteQuery();
  const term = (
    Array.isArray(query.query) ? query.query[0] : (query.query ?? '')
  ).trim();
  const { hasPermission } = useUser();
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const pendingMore = useRef<{
    count: number;
    button: HTMLButtonElement;
  } | null>(null);

  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    loadError,
    mutate,
  } = useDiscover<MovieResult | TvResult | PersonResult>(
    term ? '/api/v1/search' : '',
    { query: term },
    { hideAvailable: false, hideBlocklisted: false, hideRequested: false }
  );
  const visibleTitles = titles.filter(
    (title) =>
      hasPermission([Permission.MANAGE_BLOCKLIST, Permission.VIEW_BLOCKLIST], {
        type: 'or',
      }) ||
      !('mediaInfo' in title) ||
      title.mediaInfo?.status !== MediaStatus.BLOCKLISTED
  );
  const busy = isLoadingInitialData || isLoadingMore || refreshing;

  useEffect(() => {
    const pending = pendingMore.current;
    if (!pending || isLoadingMore || refreshing) return;
    const focusRemainsOnAction =
      document.activeElement === pending.button ||
      (!pending.button.isConnected && document.activeElement === document.body);
    if (visibleTitles.length > pending.count) {
      if (focusRemainsOnAction) {
        listRef.current
          ?.querySelectorAll('ul.cards-vertical > li')
          [
            pending.count
          ]?.querySelector<HTMLElement>('[tabindex="0"], a[href], button:not([disabled])')
          ?.focus();
      }
      pendingMore.current = null;
    } else if (loadError || isReachingEnd) {
      if (
        isReachingEnd &&
        !pending.button.isConnected &&
        focusRemainsOnAction
      ) {
        listRef.current
          ?.querySelectorAll('ul.cards-vertical > li')
          [
            visibleTitles.length - 1
          ]?.querySelector<HTMLElement>('[tabindex="0"], a[href], button:not([disabled])')
          ?.focus();
      }
      pendingMore.current = null;
    }
  }, [
    visibleTitles.length,
    isLoadingMore,
    refreshing,
    loadError,
    isReachingEnd,
  ]);
  useEffect(() => {
    pendingMore.current = null;
  }, [term]);

  const refresh = async () => {
    if (busy || refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      await Promise.resolve(mutate?.());
    } catch {
      /* Keep cached results available beside the retry action. */
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };
  const editSearch = () => {
    const input = document.querySelector<HTMLInputElement>('#search_field');
    input?.focus();
    input?.select();
  };

  return (
    <>
      <PageTitle
        title={
          term
            ? intl.formatMessage(messages.queryContext, { query: term })
            : intl.formatMessage(messages.search)
        }
      />
      <div className="mb-5 mt-1 [&_h2]:whitespace-normal [&_h2]:break-words">
        <Header
          subtext={
            term ? (
              <span className="break-words">
                {intl.formatMessage(messages.queryContext, { query: term })}
              </span>
            ) : undefined
          }
        >
          {intl.formatMessage(messages.searchresults)}
        </Header>
      </div>
      {!term ? (
        <EmptyState
          icon={MagnifyingGlassIcon}
          title={intl.formatMessage(messages.findTitle)}
          description={intl.formatMessage(messages.searchHint)}
          action={
            <Button type="button" className="min-h-11" onClick={editSearch}>
              {intl.formatMessage(messages.startSearch)}
            </Button>
          }
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p role="status" className="text-sm text-gray-400">
              {isLoadingInitialData
                ? intl.formatMessage(messages.searching)
                : intl.formatMessage(messages.resultsLoaded, {
                    count: visibleTitles.length,
                  })}
            </p>
            <Button
              type="button"
              className="min-h-11"
              aria-disabled={busy}
              aria-busy={refreshing}
              onClick={() => void refresh()}
            >
              <ArrowPathIcon
                aria-hidden="true"
                className={
                  refreshing ? 'animate-spin motion-reduce:animate-none' : ''
                }
              />
              <span>
                {intl.formatMessage(
                  refreshing
                    ? messages.refreshingResults
                    : loadError
                      ? messages.retry
                      : messages.refreshResults
                )}
              </span>
            </Button>
          </div>
          {loadError && (
            <p
              role="status"
              className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200"
            >
              {intl.formatMessage(
                visibleTitles.length
                  ? messages.savedResultsError
                  : messages.loadError
              )}
            </p>
          )}
          <div ref={listRef}>
            <ListView
              items={visibleTitles}
              isEmpty={
                !loadError &&
                (isEmpty ||
                  (!isLoadingInitialData && visibleTitles.length === 0))
              }
              isLoading={
                isLoadingInitialData ||
                (isLoadingMore && visibleTitles.length > 0)
              }
              isReachingEnd={isReachingEnd}
              onScrollBottom={() => {
                if (!busy && !loadError) fetchMore();
              }}
              emptyContent={
                <EmptyState
                  icon={MagnifyingGlassIcon}
                  title={intl.formatMessage(messages.noResults, {
                    query: term,
                  })}
                  description={intl.formatMessage(
                    messages.noResultsDescription
                  )}
                  action={
                    <Button
                      type="button"
                      className="min-h-11"
                      onClick={editSearch}
                    >
                      {intl.formatMessage(messages.editSearch)}
                    </Button>
                  }
                />
              }
            />
          </div>
          {!isLoadingInitialData &&
            visibleTitles.length > 0 &&
            isReachingEnd &&
            !loadError && (
              <p
                role="status"
                className="mt-6 text-center text-sm text-gray-400"
              >
                {intl.formatMessage(messages.endOfResults)}
              </p>
            )}
          {!isLoadingInitialData &&
            visibleTitles.length > 0 &&
            (!isReachingEnd || loadError) && (
              <div className="mt-6 flex justify-center">
                <Button
                  ref={moreRef}
                  type="button"
                  className="min-h-11 w-full justify-center sm:w-auto"
                  aria-disabled={busy}
                  aria-busy={isLoadingMore || refreshing}
                  onClick={() => {
                    if (busy) return;
                    if (moreRef.current)
                      pendingMore.current = {
                        count: visibleTitles.length,
                        button: moreRef.current,
                      };
                    if (loadError) void refresh();
                    else fetchMore();
                  }}
                >
                  {intl.formatMessage(
                    isLoadingMore || refreshing
                      ? messages.loadingMore
                      : loadError
                        ? messages.retry
                        : messages.loadMore
                  )}
                </Button>
              </div>
            )}
        </>
      )}
    </>
  );
};

export default Search;
