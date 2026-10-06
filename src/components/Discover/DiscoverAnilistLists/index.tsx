import Button from '@app/components/Common/Button';
import CompactCardGrid from '@app/components/Common/CompactCardGrid';
import EmptyState from '@app/components/Common/EmptyState';
import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import DiscoverProviderMessage from '@app/components/Discover/DiscoverProviderMessage';
import { SliderSourceTitle } from '@app/components/Discover/SliderSourceMark';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowPathIcon,
  QueueListIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { Link, useSearchParams } from 'react-router';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.DiscoverAnilistLists', {
  title: 'Your AniList Lists',
  description:
    'Browse every list in your AniList library, including custom lists. Open a list to see its anime.',
  linkAccount: 'Link your AniList account to browse your lists.',
  statusLists: 'Status Lists',
  customLists: 'Custom Lists',
  items: '{count, plural, one {# entry} other {# entries}}',
  findList: 'Find a list',
  findListPlaceholder: 'Search by list name',
  clearSearch: 'Clear search',
  listsShown: '{count} of {total} lists shown',
  refreshLists: 'Refresh lists',
  refreshingLists: 'Refreshing lists…',
  retry: 'Try again',
  loadingLists: 'Loading your AniList lists…',
  listsError: 'Could not load your AniList lists. Try again.',
  savedListsError:
    'Could not update your lists. Your previously loaded lists are still available.',
  noLists: 'No AniList lists found',
  noListsDescription:
    'Add anime to your AniList library or create a custom list, then refresh here.',
  noMatchingLists: 'No lists match your search',
  noMatchingDescription:
    'Try another list name, or clear the search to show all lists.',
});

interface AnilistListResult {
  name: string;
  status: string | null;
  isCustomList: boolean;
  itemCount: number;
}

const DiscoverAnilistLists = () => {
  const intl = useIntl();
  const settings = useSettings();
  const { user } = useUser();
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.get('q') ?? '';
  const searchRef = useRef<HTMLInputElement>(null);
  const refreshingRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const {
    data: anilistStatus,
    error: accountError,
    mutate: refreshAccount,
    isValidating: checkingAccount,
  } = useSWR<{ connected: boolean }>(
    settings.currentSettings.anilistConfigured && user
      ? `/api/v1/user/${user.id}/settings/linked-accounts/anilist`
      : null
  );
  const {
    data,
    error,
    mutate: refreshLists,
    isValidating: updatingLists,
  } = useSWR<{ results: AnilistListResult[] }>(
    anilistStatus?.connected ? '/api/v1/discover/anilist/lists' : null
  );

  if (!settings.currentSettings.anilistConfigured) {
    return <ErrorPage statusCode={404} />;
  }

  if (anilistStatus && !anilistStatus.connected) {
    return (
      <DiscoverProviderMessage
        title={intl.formatMessage(messages.title)}
        source="anilist"
        message={intl.formatMessage(messages.linkAccount)}
        linkAccount
      />
    );
  }

  const lists = data?.results ?? [];
  const normalizedSearch = search.trim().toLocaleLowerCase(intl.locale);
  const filteredLists = lists.filter((list) =>
    list.name.toLocaleLowerCase(intl.locale).includes(normalizedSearch)
  );
  const busy = refreshing || checkingAccount || updatingLists;
  const loading = !data && !error && !accountError;

  const updateSearch = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set('q', value);
    else next.delete('q');
    setSearchParams(next, { replace: true, preventScrollReset: true });
  };
  const clearSearch = () => {
    updateSearch('');
    searchRef.current?.focus();
  };
  const refresh = async () => {
    if (refreshingRef.current || busy) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      if (!anilistStatus?.connected || accountError) {
        const status = await refreshAccount();
        if (!status?.connected) return;
      }
      await refreshLists();
    } catch {
      // SWR exposes the failure alongside any cached lists.
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  };

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.title)} />
      <div className="mb-5 mt-1 [&_h2]:whitespace-normal [&_h2]:break-words">
        <Header subtext={intl.formatMessage(messages.description)}>
          <SliderSourceTitle source="anilist">
            {intl.formatMessage(messages.title)}
          </SliderSourceTitle>
        </Header>
      </div>
      <div className="mb-4 flex flex-col gap-3 rounded-xl border border-gray-700 bg-gray-800/50 p-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 flex-1 sm:max-w-lg">
          <label
            htmlFor="anilist-list-search"
            className="mb-2 block text-sm font-medium text-gray-300"
          >
            {intl.formatMessage(messages.findList)}
          </label>
          <div className="relative">
            <input
              ref={searchRef}
              id="anilist-list-search"
              type="search"
              value={search}
              onChange={(event) => updateSearch(event.target.value)}
              placeholder={intl.formatMessage(messages.findListPlaceholder)}
              className="min-h-11 w-full pr-12"
            />
            {search && (
              <button
                type="button"
                aria-label={intl.formatMessage(messages.clearSearch)}
                onClick={clearSearch}
                className="absolute inset-y-0 right-0 flex min-h-11 min-w-11 items-center justify-center rounded-md text-gray-400 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                <XMarkIcon aria-hidden="true" className="h-5 w-5" />
              </button>
            )}
          </div>
        </div>
        <Button
          type="button"
          className="min-h-11"
          aria-disabled={busy}
          aria-busy={busy}
          onClick={() => void refresh()}
        >
          <ArrowPathIcon
            aria-hidden="true"
            className={busy ? 'animate-spin motion-reduce:animate-none' : ''}
          />
          <span>
            {intl.formatMessage(
              busy
                ? messages.refreshingLists
                : error || accountError
                  ? messages.retry
                  : messages.refreshLists
            )}
          </span>
        </Button>
      </div>
      {(error || accountError) && (
        <p
          role="status"
          className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200"
        >
          {intl.formatMessage(
            data ? messages.savedListsError : messages.listsError
          )}
        </p>
      )}
      {loading && (
        <div
          role="status"
          aria-label={intl.formatMessage(messages.loadingLists)}
        >
          <LoadingSpinner />
        </div>
      )}
      {data && (
        <p role="status" className="mb-4 text-sm text-gray-400">
          {intl.formatMessage(messages.listsShown, {
            count: intl.formatNumber(filteredLists.length),
            total: intl.formatNumber(lists.length),
          })}
        </p>
      )}
      {data && !filteredLists.length && (
        <EmptyState
          icon={QueueListIcon}
          title={intl.formatMessage(
            normalizedSearch ? messages.noMatchingLists : messages.noLists
          )}
          description={intl.formatMessage(
            normalizedSearch
              ? messages.noMatchingDescription
              : messages.noListsDescription
          )}
          action={
            normalizedSearch ? (
              <Button type="button" className="min-h-11" onClick={clearSearch}>
                {intl.formatMessage(messages.clearSearch)}
              </Button>
            ) : undefined
          }
        />
      )}
      {[
        {
          title: intl.formatMessage(messages.statusLists),
          lists: filteredLists.filter((list) => !list.isCustomList),
        },
        {
          title: intl.formatMessage(messages.customLists),
          lists: filteredLists.filter((list) => list.isCustomList),
        },
      ].map(
        (section) =>
          section.lists.length > 0 && (
            <section key={section.title} className="mb-6">
              <h2 className="mb-3 text-xl font-semibold text-white">
                {section.title}
              </h2>
              <CompactCardGrid
                columns="sm:grid-cols-[repeat(auto-fill,minmax(14rem,1fr))]"
                gap={12}
              >
                {section.lists.map((list) => (
                  <Link
                    key={list.name}
                    to={`/discover/anilist/list?name=${encodeURIComponent(list.name)}`}
                    className="flex flex-col rounded-xl bg-gray-800 p-4 shadow ring-1 ring-gray-700 transition duration-300 hover:shadow-lg hover:ring-gray-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 motion-reduce:transition-none"
                  >
                    <div className="break-words text-lg font-semibold text-white">
                      {list.name}
                    </div>
                    <div className="pt-2 text-sm text-gray-400">
                      {intl.formatMessage(messages.items, {
                        count: list.itemCount,
                      })}
                    </div>
                  </Link>
                ))}
              </CompactCardGrid>
            </section>
          )
      )}
    </>
  );
};

export default DiscoverAnilistLists;
