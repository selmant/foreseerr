import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import TvFocusable from '@app/components/Tv/TvFocusable';
import { useNativeRuntime } from '@app/context/NativeRuntimeContext';
import useDiscover from '@app/hooks/useDiscover';
import useRouteQuery from '@app/hooks/useRouteQuery';
import useSearchInput from '@app/hooks/useSearchInput';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { MagnifyingGlassIcon } from '@heroicons/react/24/solid';
import type {
  MovieResult,
  PersonResult,
  TvResult,
} from '@server/models/Search';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Search', {
  search: 'Search',
  searchresults: 'Search Results',
  searchPlaceholder: 'Search Movies & Series',
});

const Search = () => {
  const intl = useIntl();
  const query = useRouteQuery();
  const { isTvShell } = useNativeRuntime();
  const { searchValue, setSearchValue, setIsOpen } = useSearchInput();

  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    error,
  } = useDiscover<MovieResult | TvResult | PersonResult>(
    `/api/v1/search`,
    {
      query: query.query,
    },
    { hideAvailable: false, hideBlocklisted: false }
  );

  if (error) {
    return <ErrorPage statusCode={500} />;
  }

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.search)} />
      {isTvShell ? (
        <div className="mb-6">
          <TvFocusable
            onEnterPress={() =>
              document.getElementById('tv_search_field')?.focus()
            }
          >
            <div>
              <label htmlFor="tv_search_field" className="sr-only">
                {intl.formatMessage(messages.search)}
              </label>
              <div className="relative">
                <MagnifyingGlassIcon className="pointer-events-none absolute left-4 top-1/2 h-6 w-6 -translate-y-1/2 text-gray-400" />
                <input
                  id="tv_search_field"
                  className="block w-full rounded-xl border border-gray-600 bg-gray-900 py-4 pl-14 pr-4 text-xl text-white placeholder-gray-400 focus:border-indigo-400 focus:outline-none"
                  placeholder={intl.formatMessage(messages.searchPlaceholder)}
                  type="search"
                  autoComplete="off"
                  value={searchValue}
                  onChange={(e) => setSearchValue(e.target.value)}
                  onFocus={() => setIsOpen(true)}
                />
              </div>
            </div>
          </TvFocusable>
        </div>
      ) : (
        <div className="mb-5 mt-1">
          <Header>{intl.formatMessage(messages.searchresults)}</Header>
        </div>
      )}
      <ListView
        items={titles}
        isEmpty={isEmpty}
        isLoading={
          isLoadingInitialData || (isLoadingMore && (titles?.length ?? 0) > 0)
        }
        isReachingEnd={isReachingEnd}
        onScrollBottom={fetchMore}
      />
    </>
  );
};

export default Search;
