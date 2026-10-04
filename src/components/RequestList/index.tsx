import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import LinkButton from '@app/components/Common/LinkButton';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import RequestItem from '@app/components/RequestList/RequestItem';
import useRouteQuery from '@app/hooks/useRouteQuery';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import {
  ArrowDownIcon,
  ArrowPathIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from '@heroicons/react/24/solid';
import type { RequestResultsResponse } from '@server/interfaces/api/requestInterfaces';
import { useEffect, useMemo } from 'react';
import { useIntl } from 'react-intl';
import { Link, useLocation, useNavigate } from 'react-router';
import useSWR from 'swr';
import {
  parseRequestListState,
  requestFilters,
  requestListPath,
  requestPageSizes,
  type RequestFilter,
  type RequestListState,
} from './queryState';

const messages = defineMessages('components.RequestList', {
  requests: 'Requests',
  showallrequests: 'Show All Requests',
  sortAdded: 'Requested date',
  sortModified: 'Last modified',
  description: 'Track request approvals, downloads and episode coverage.',
  mediaType: 'Content type',
  status: 'Status filter',
  sort: 'Sort by',
  newest: 'Newest first',
  oldest: 'Oldest first',
  sortDirection: 'Sort direction: {direction}',
  allTypes: 'Movies & series',
  allStatuses: 'All requests',
  controls: 'Request filters and sorting',
  filterHint: 'Filter by request status or library availability.',
  refresh: 'Refresh',
  count: '{count, plural, one {# request} other {# requests}}',
  loading: 'Loading requests…',
  unavailableCount: 'Request count unavailable',
  loadError: 'Could not load requests. Try again.',
  retry: 'Try again',
  noMatches: 'No requests match these filters',
  noMatchesHint: 'Try another status or content type, or show all requests.',
  noPending: 'No requests are waiting for approval',
  noPendingHint: 'New requests that need approval will appear here.',
  empty: 'No requests yet',
  emptyHint: 'Find a movie or series on Discover to make your first request.',
  emptyPage: 'No requests on this page',
  firstPage: 'Go to first page',
  discover: 'Browse Discover',
  page: 'Page {page} of {total}',
  pageSize: 'Per page',
  pagination: 'Request pagination',
  unableToConnect:
    'Unable to connect to {services}. Some information may be unavailable.',
});

const readPreferences = (): unknown => {
  try {
    return JSON.parse(
      window.localStorage.getItem('rl-filter-settings') ?? '{}'
    );
  } catch {
    return {};
  }
};

const RequestList = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const routeQuery = useRouteQuery();
  const intl = useIntl();
  const { user } = useUser({ id: Number(routeQuery.userId) });
  const { user: currentUser, hasPermission } = useUser();
  const preferences = useMemo(readPreferences, []);
  const state = useMemo(
    () => parseRequestListState(location.search, preferences),
    [location.search, preferences]
  );
  const isProfile = location.pathname.startsWith('/profile');
  const requestedBy = isProfile ? currentUser?.id : routeQuery.userId;
  const pageIndex = state.page - 1;
  const update = (patch: Partial<RequestListState>) =>
    navigate(
      requestListPath(
        location.pathname,
        { ...state, page: 1, ...patch },
        location.search
      )
    );

  useEffect(() => {
    const path = requestListPath(location.pathname, state, location.search);
    if (path !== `${location.pathname}${location.search}`)
      navigate(path, { replace: true });
    try {
      window.localStorage.setItem(
        'rl-filter-settings',
        JSON.stringify({
          currentFilter: state.filter,
          currentMediaType: state.mediaType,
          currentSort: state.sort,
          currentSortDirection: state.sortDirection,
          currentPageSize: state.pageSize,
        })
      );
    } catch {
      /* Browsing also works when storage is unavailable. */
    }
  }, [location.pathname, location.search, navigate, state]);

  const {
    data,
    error,
    isValidating,
    mutate: revalidate,
  } = useSWR<RequestResultsResponse>(
    isProfile && !currentUser
      ? null
      : `/api/v1/request?take=${state.pageSize}&skip=${pageIndex * state.pageSize}&filter=${state.filter}&mediaType=${state.mediaType}&sort=${state.sort}&sortDirection=${state.sortDirection}${requestedBy ? `&requestedBy=${encodeURIComponent(String(requestedBy))}` : ''}`
  );
  const hasFilters = state.filter !== 'all' || state.mediaType !== 'all';
  const filterLabels = {
    all: messages.allStatuses,
    pending: globalMessages.pending,
    approved: globalMessages.approved,
    completed: globalMessages.completed,
    processing: globalMessages.processing,
    failed: globalMessages.failed,
    available: globalMessages.available,
    unavailable: globalMessages.unavailable,
    deleted: globalMessages.deleted,
  };
  const noPending = state.filter === 'pending' && state.mediaType === 'all';
  const showAll = () => update({ filter: 'all', mediaType: 'all' });
  const totalPages = Math.max(1, data?.pageInfo.pages ?? 1);
  const changePage = (page: number) => {
    update({ page });
    window.scrollTo(0, 0);
  };

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.requests),
          routeQuery.userId ? user?.displayName : '',
        ]}
      />
      <div className="mb-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Header
            subtext={
              isProfile ? (
                <Link to="/profile" className="hover:underline">
                  {currentUser?.displayName}
                </Link>
              ) : routeQuery.userId ? (
                <Link to={`/users/${user?.id}`} className="hover:underline">
                  {user?.displayName}
                </Link>
              ) : (
                ''
              )
            }
          >
            {intl.formatMessage(messages.requests)}
          </Header>
          <Button
            className="min-h-11"
            onClick={() => void revalidate()}
            disabled={isValidating || (isProfile && !currentUser)}
            aria-busy={isValidating}
          >
            <ArrowPathIcon className={isValidating ? 'animate-spin' : ''} />
            <span>{intl.formatMessage(messages.refresh)}</span>
          </Button>
        </div>
        <p className="text-sm text-gray-400">
          {intl.formatMessage(messages.description)}
        </p>
        <div
          role="group"
          aria-label={intl.formatMessage(messages.controls)}
          className="grid gap-3 rounded-xl border border-gray-700 bg-gray-800/60 p-4 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_1fr_auto]"
        >
          <div>
            <label htmlFor="request-media-type">
              {intl.formatMessage(messages.mediaType)}
            </label>
            <select
              id="request-media-type"
              className="min-h-11 w-full"
              value={state.mediaType}
              onChange={(event) =>
                update({
                  mediaType: event.target
                    .value as RequestListState['mediaType'],
                })
              }
            >
              <option value="all">
                {intl.formatMessage(messages.allTypes)}
              </option>
              <option value="movie">
                {intl.formatMessage(globalMessages.movies)}
              </option>
              <option value="tv">
                {intl.formatMessage(globalMessages.tvshows)}
              </option>
            </select>
          </div>
          <div>
            <label htmlFor="request-filter">
              {intl.formatMessage(messages.status)}
            </label>
            <select
              id="request-filter"
              className="min-h-11 w-full"
              value={state.filter}
              onChange={(event) =>
                update({ filter: event.target.value as RequestFilter })
              }
            >
              {requestFilters.map((filter) => (
                <option key={filter} value={filter}>
                  {intl.formatMessage(filterLabels[filter])}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="request-sort">
              {intl.formatMessage(messages.sort)}
            </label>
            <select
              id="request-sort"
              className="min-h-11 w-full"
              value={state.sort}
              onChange={(event) =>
                update({ sort: event.target.value as RequestListState['sort'] })
              }
            >
              <option value="added">
                {intl.formatMessage(messages.sortAdded)}
              </option>
              <option value="modified">
                {intl.formatMessage(messages.sortModified)}
              </option>
            </select>
          </div>
          <Button
            className="min-h-11 self-end"
            aria-label={intl.formatMessage(messages.sortDirection, {
              direction: intl.formatMessage(
                state.sortDirection === 'asc'
                  ? messages.oldest
                  : messages.newest
              ),
            })}
            onClick={() =>
              update({
                sortDirection: state.sortDirection === 'asc' ? 'desc' : 'asc',
              })
            }
          >
            {state.sortDirection === 'asc' ? (
              <ArrowUpIcon />
            ) : (
              <ArrowDownIcon />
            )}
            <span>
              {intl.formatMessage(
                state.sortDirection === 'asc'
                  ? messages.oldest
                  : messages.newest
              )}
            </span>
          </Button>
        </div>
        <p className="text-xs text-gray-400">
          {intl.formatMessage(messages.filterHint)}
        </p>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p role="status" className="text-sm text-gray-400">
            {intl.formatMessage(
              data
                ? messages.count
                : error
                  ? messages.unavailableCount
                  : messages.loading,
              {
                count: data?.pageInfo.results ?? 0,
              }
            )}
          </p>
          {hasFilters && (
            <Button className="min-h-11" onClick={showAll}>
              {intl.formatMessage(messages.showallrequests)}
            </Button>
          )}
        </div>
      </div>
      {error && (
        <Alert type="error" title={intl.formatMessage(messages.loadError)}>
          <Button
            className="min-h-11"
            disabled={isValidating}
            onClick={() => void revalidate()}
          >
            {intl.formatMessage(messages.retry)}
          </Button>
        </Alert>
      )}
      {data?.serviceErrors &&
        (data.serviceErrors.radarr.length > 0 ||
          data.serviceErrors.sonarr.length > 0) &&
        hasPermission(
          [Permission.MANAGE_REQUESTS, Permission.REQUEST_ADVANCED],
          { type: 'or' }
        ) && (
          <div className="service-error-banner">
            <ExclamationTriangleIcon className="h-5 w-5 shrink-0" />
            <span>
              {intl.formatMessage(messages.unableToConnect, {
                services: [
                  ...data.serviceErrors.radarr,
                  ...data.serviceErrors.sonarr,
                ]
                  .map((service) => service.name)
                  .join(', '),
              })}
            </span>
          </div>
        )}
      {!data && !error && <LoadingSpinner />}
      {data?.results.map((request) => (
        <div className="py-2" key={request.id}>
          <RequestItem
            request={request}
            revalidateList={() => void revalidate()}
          />
        </div>
      ))}
      {data && data.results.length === 0 && (
        <div className="space-y-3 rounded-xl border border-gray-700 bg-gray-800/40 px-4 py-12 text-center">
          <p className="text-lg font-semibold text-gray-200">
            {intl.formatMessage(
              data.pageInfo.results > 0
                ? messages.emptyPage
                : noPending
                  ? messages.noPending
                  : hasFilters
                    ? messages.noMatches
                    : messages.empty
            )}
          </p>
          <p className="mx-auto max-w-md text-sm text-gray-400">
            {intl.formatMessage(
              noPending
                ? messages.noPendingHint
                : hasFilters
                  ? messages.noMatchesHint
                  : messages.emptyHint
            )}
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            {data.pageInfo.results > 0 ? (
              <Button className="min-h-11" onClick={() => changePage(1)}>
                {intl.formatMessage(messages.firstPage)}
              </Button>
            ) : (
              hasFilters && (
                <Button
                  className="min-h-11"
                  buttonType="primary"
                  onClick={showAll}
                >
                  {intl.formatMessage(messages.showallrequests)}
                </Button>
              )
            )}
            <LinkButton to="/discover" className="min-h-11">
              {intl.formatMessage(messages.discover)}
            </LinkButton>
          </div>
        </div>
      )}
      {data && data.pageInfo.results > 0 && (
        <nav
          className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-gray-700 pt-4"
          aria-label={intl.formatMessage(messages.pagination)}
        >
          <p className="text-sm text-gray-400">
            {intl.formatMessage(messages.page, {
              page: state.page,
              total: totalPages,
            })}
          </p>
          <div className="flex items-center gap-2">
            <label
              htmlFor="request-page-size"
              className="mb-0 whitespace-nowrap text-sm text-gray-400"
            >
              {intl.formatMessage(messages.pageSize)}
            </label>
            <select
              id="request-page-size"
              className="min-h-11 w-20"
              value={state.pageSize}
              onChange={(event) =>
                update({ pageSize: Number(event.target.value) })
              }
            >
              {requestPageSizes.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <Button
              className="min-h-11"
              disabled={state.page <= 1}
              onClick={() => changePage(state.page - 1)}
            >
              <ChevronLeftIcon />
              <span>{intl.formatMessage(globalMessages.previous)}</span>
            </Button>
            <Button
              className="min-h-11"
              disabled={state.page >= totalPages}
              onClick={() => changePage(state.page + 1)}
            >
              <span>{intl.formatMessage(globalMessages.next)}</span>
              <ChevronRightIcon />
            </Button>
          </div>
        </nav>
      )}
    </>
  );
};

export default RequestList;
