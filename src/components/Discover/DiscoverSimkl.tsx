import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import PageTitle from '@app/components/Common/PageTitle';
import DiscoverProviderMessage from '@app/components/Discover/DiscoverProviderMessage';
import DiscoverProviderResults from '@app/components/Discover/DiscoverProviderResults';
import { SliderSourceTitle } from '@app/components/Discover/SliderSourceMark';
import useDiscover, { providerListFilters } from '@app/hooks/useDiscover';
import useRouteQuery from '@app/hooks/useRouteQuery';
import useSettings from '@app/hooks/useSettings';
import { useQueryParams } from '@app/hooks/useUpdateQueryParams';
import { useUser } from '@app/hooks/useUser';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import type {
  WatchlistItem,
  WatchlistResponse,
} from '@server/interfaces/api/discoverInterfaces';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.DiscoverSimkl', {
  trending: 'Simkl Trending',
  watching: 'Simkl Watching',
  plantowatch: 'Simkl Plan to Watch',
  hold: 'Simkl On Hold',
  completed: 'Simkl Completed',
  dropped: 'Simkl Dropped',
  linkAccount:
    'Link your Simkl account in Linked Accounts to browse your library.',
  trendingDescription:
    'See what’s trending on Simkl. Choose a content type and time period to explore.',
  libraryDescription:
    'Titles from your linked Simkl library, grouped by your watch status.',
  contentType: 'Content type',
  allTypes: 'Movies, series & anime',
  movies: 'Movies',
  series: 'Series',
  anime: 'Anime',
  period: 'Time period',
  day: 'Today',
  week: 'This week',
  month: 'This month',
  emptyTrending: 'Try another content type or time period.',
  emptyLibrary:
    'Try another watch status or content type. Titles appear here from your linked Simkl account.',
  resetFilters: 'Reset filters',
  stale: 'Simkl could not update your library. Showing the last saved titles.',
  lastSynced: 'Last synced {date}.',
});

type LibraryStatus =
  | 'watching'
  | 'plantowatch'
  | 'hold'
  | 'completed'
  | 'dropped';

const libraryStatuses = new Set<string>([
  'watching',
  'plantowatch',
  'hold',
  'completed',
  'dropped',
]);

const publicViews = {
  trending: {
    title: 'trending',
    endpoint: '/api/v1/discover/simkl/trending',
  },
} as const;

const DiscoverSimkl = () => {
  const intl = useIntl();
  const settings = useSettings();
  const { user } = useUser();
  const query = useRouteQuery();
  const updateQuery = useQueryParams();
  const mediaType =
    query.mediaType === 'movie' ||
    query.mediaType === 'tv' ||
    query.mediaType === 'anime'
      ? query.mediaType
      : 'all';
  const period =
    query.period === 'day' || query.period === 'month' ? query.period : 'week';
  const viewKey = typeof query.view === 'string' ? query.view : undefined;
  const view = viewKey
    ? publicViews[viewKey as keyof typeof publicViews]
    : undefined;
  const status: LibraryStatus =
    typeof query.status === 'string' && libraryStatuses.has(query.status)
      ? (query.status as LibraryStatus)
      : 'plantowatch';
  const title = intl.formatMessage(messages[view ? view.title : status]);
  const {
    data: simklStatus,
    error: accountError,
    mutate: refreshAccount,
  } = useSWR<{ connected: boolean }>(
    settings.currentSettings.simklConfigured && !view && user
      ? `/api/v1/user/${user.id}/settings/linked-accounts/simkl`
      : null
  );
  const notLinked = !view && simklStatus?.connected === false;
  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    loadError,
    mutate,
    firstResultData,
  } = useDiscover<WatchlistItem, Pick<WatchlistResponse, 'providerState'>>(
    settings.currentSettings.simklConfigured &&
      (!viewKey || view) &&
      (view || simklStatus?.connected === true)
      ? view
        ? view.endpoint
        : '/api/v1/discover/simkl/library'
      : '',
    view ? { mediaType, period } : { status, mediaType },
    providerListFilters
  );
  if (viewKey && !view) return <ErrorPage statusCode={404} />;
  if (!settings.currentSettings.simklConfigured)
    return <ErrorPage statusCode={404} />;
  if (notLinked)
    return (
      <DiscoverProviderMessage
        title={title}
        source="simkl"
        message={intl.formatMessage(messages.linkAccount)}
        linkAccount
      />
    );
  const lastSynced = firstResultData?.providerState?.lastSuccessfulSyncAt;
  const validSyncDate = lastSynced && Number.isFinite(Date.parse(lastSynced));
  return (
    <>
      <PageTitle title={title} />
      <div className="mb-5 mt-1 space-y-4 [&_h2]:whitespace-normal [&_h2]:break-words">
        <Header>
          <SliderSourceTitle source="simkl">{title}</SliderSourceTitle>
        </Header>
        <p className="max-w-2xl text-sm leading-6 text-gray-400">
          {intl.formatMessage(
            view ? messages.trendingDescription : messages.libraryDescription
          )}
        </p>
        <div className="flex flex-wrap gap-4">
          <div className="min-w-0 flex-1 basis-full sm:max-w-xs sm:basis-auto">
            <label
              htmlFor="simkl-content-type"
              className="mb-1 block text-sm text-gray-300"
            >
              {intl.formatMessage(messages.contentType)}
            </label>
            <select
              id="simkl-content-type"
              className="min-h-[44px] w-full"
              value={mediaType}
              onChange={(event) =>
                updateQuery({
                  mediaType:
                    event.target.value === 'all'
                      ? undefined
                      : event.target.value,
                  page: undefined,
                })
              }
            >
              <option value="all">
                {intl.formatMessage(messages.allTypes)}
              </option>
              <option value="movie">
                {intl.formatMessage(messages.movies)}
              </option>
              <option value="tv">{intl.formatMessage(messages.series)}</option>
              <option value="anime">
                {intl.formatMessage(messages.anime)}
              </option>
            </select>
          </div>
          {view && (
            <div className="min-w-0 flex-1 basis-full sm:max-w-xs sm:basis-auto">
              <label
                htmlFor="simkl-period"
                className="mb-1 block text-sm text-gray-300"
              >
                {intl.formatMessage(messages.period)}
              </label>
              <select
                id="simkl-period"
                className="min-h-[44px] w-full"
                value={period}
                onChange={(event) =>
                  updateQuery({
                    period:
                      event.target.value === 'week'
                        ? undefined
                        : event.target.value,
                    page: undefined,
                  })
                }
              >
                <option value="day">{intl.formatMessage(messages.day)}</option>
                <option value="week">
                  {intl.formatMessage(messages.week)}
                </option>
                <option value="month">
                  {intl.formatMessage(messages.month)}
                </option>
              </select>
            </div>
          )}
        </div>
      </div>
      {!view && firstResultData?.providerState?.stale && (
        <Alert type="info" title={intl.formatMessage(messages.stale)}>
          {validSyncDate &&
            intl.formatMessage(messages.lastSynced, {
              date: intl.formatDate(lastSynced, {
                dateStyle: 'medium',
                timeStyle: 'short',
              }),
            })}
        </Alert>
      )}
      <DiscoverProviderResults
        source="Simkl"
        titles={titles}
        isEmpty={isEmpty}
        isLoadingInitialData={isLoadingInitialData && !accountError}
        isLoadingMore={isLoadingMore && !accountError}
        isReachingEnd={isReachingEnd}
        fetchMore={fetchMore}
        error={!view ? accountError || loadError : loadError}
        onRefresh={async () => {
          if (!view) await refreshAccount();
          await mutate?.();
        }}
        mutate={mutate}
        emptyDescription={intl.formatMessage(
          view ? messages.emptyTrending : messages.emptyLibrary
        )}
        emptyAction={
          mediaType !== 'all' || (view && period !== 'week') ? (
            <Button
              type="button"
              className="min-h-[44px]"
              onClick={() =>
                updateQuery({
                  mediaType: undefined,
                  period: undefined,
                  page: undefined,
                })
              }
            >
              {intl.formatMessage(messages.resetFilters)}
            </Button>
          ) : undefined
        }
      />
    </>
  );
};

export default DiscoverSimkl;
