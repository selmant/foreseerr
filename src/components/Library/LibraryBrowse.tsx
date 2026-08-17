import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import LibraryBrowseFilters from '@app/components/Library/LibraryBrowseFilters';
import LibraryBrowseGrid from '@app/components/Library/LibraryBrowseGrid';
import LibraryBrowseToolbar from '@app/components/Library/LibraryBrowseToolbar';
import LibraryInspector from '@app/components/Library/LibraryInspector';
import LibraryModeNav from '@app/components/Library/LibraryModeNav';
import {
  browseStateFromQuery,
  mergeBrowsePatch,
  restoreBrowseScroll,
  serializeBrowseApiQuery,
  serializeBrowseState,
  storeBrowseScroll,
  storeDensity,
} from '@app/components/Library/browseUrlState';
import useLibraryInfiniteScroll from '@app/components/Library/useLibraryInfiniteScroll';
import ManageSlideOver from '@app/components/ManageSlideOver';
import defineMessages from '@app/utils/defineMessages';
import { registerLibraryShelfRevalidator } from '@app/utils/mediaActionInvalidation';
import type {
  LibraryBrowseResponse,
  LibraryFacetsResponse,
  LibraryTitle,
} from '@server/interfaces/api/libraryInterfaces';
import type { ParsedLibraryBrowseQuery } from '@server/lib/libraryBrowseQuery';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import useSWRInfinite from 'swr/infinite';

const PAGE_SIZE = 24;

const messages = defineMessages('components.Library.LibraryBrowse', {
  library: 'Library',
  browse: 'Browse',
  subtitle: 'Search and filter everything in your Jellyfin library.',
  notLinked: 'Link your Jellyfin account in settings to browse your library.',
  unsupported: 'Complete Library browse requires a Jellyfin media server.',
  unreachable: 'Could not reach Jellyfin.',
});

const paramsFromState = (state: ReturnType<typeof browseStateFromQuery>) => {
  const params = serializeBrowseState({ ...state, take: PAGE_SIZE, skip: 0 });
  const query: Record<string, string | string[]> = {};
  for (const [key, value] of params.entries()) {
    if (key === 'genre') {
      const current = query.genre;
      query.genre = current
        ? [...(Array.isArray(current) ? current : [current]), value]
        : [value];
    } else {
      query[key] = value;
    }
  }
  return query;
};

const LibraryBrowse = () => {
  const intl = useIntl();
  const router = useRouter();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [inspectorItem, setInspectorItem] = useState<LibraryTitle | null>(null);
  const [managedTitle, setManagedTitle] = useState<
    | { data: MovieDetails; mediaType: 'movie' }
    | { data: TvDetails; mediaType: 'tv' }
    | null
  >(null);
  const [searchInput, setSearchInput] = useState('');

  const state = useMemo(
    () => browseStateFromQuery(router.query),
    [router.query]
  );

  useEffect(() => {
    setSearchInput(state.q ?? '');
  }, [state.q]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      const next = searchInput.trim();
      if (next === (state.q ?? '')) {
        return;
      }
      void router.replace(
        {
          pathname: '/library/browse',
          query: paramsFromState({ ...state, q: next || undefined, skip: 0 }),
        },
        undefined,
        { shallow: true }
      );
    }, 300);
    return () => window.clearTimeout(handle);
  }, [searchInput, router, state]);

  const applyPatch = (patch: Partial<ParsedLibraryBrowseQuery>) => {
    void router.replace(
      {
        pathname: '/library/browse',
        query: paramsFromState(mergeBrowsePatch(state, patch, searchInput)),
      },
      undefined,
      { shallow: true }
    );
  };

  const { data: facets } = useSWR<LibraryFacetsResponse>(
    `/api/v1/library/facets${
      state.mediaType ? `?mediaType=${state.mediaType}` : ''
    }`
  );

  const scopeKey = serializeBrowseApiQuery({ ...state, skip: 0 }).toString();
  const {
    data: pages,
    error,
    isValidating,
    mutate,
    setSize,
    size,
  } = useSWRInfinite<LibraryBrowseResponse>(
    (pageIndex, previousPageData) => {
      if (
        previousPageData &&
        previousPageData.pageInfo.page >= previousPageData.pageInfo.pages
      ) {
        return null;
      }
      const params = serializeBrowseApiQuery({
        ...state,
        take: PAGE_SIZE,
        skip: pageIndex * PAGE_SIZE,
      });
      params.set('take', String(PAGE_SIZE));
      params.set('skip', String(pageIndex * PAGE_SIZE));
      return `/api/v1/library/browse?${params.toString()}`;
    },
    { revalidateFirstPage: false }
  );

  useEffect(() => {
    setSize(1);
  }, [scopeKey, setSize]);

  const items = pages?.flatMap((page) => page.results) ?? [];
  const code = pages?.[0]?.code ?? facets?.code;
  const total = pages?.[0]?.pageInfo.results;
  const lastPage = pages?.[pages.length - 1];
  const reachedEnd =
    !lastPage || lastPage.pageInfo.page >= lastPage.pageInfo.pages;
  const loadingInitial = !pages && !error;
  const loadingMore =
    isValidating && !!pages && typeof pages[size - 1] === 'undefined';

  const loadMore = useCallback(() => {
    if (!loadingMore && !reachedEnd && !error) {
      setSize((current) => current + 1);
    }
  }, [error, loadingMore, reachedEnd, setSize]);

  useLibraryInfiniteScroll(
    sentinelRef,
    loadMore,
    !loadingInitial && !loadingMore && !reachedEnd && !error
  );

  useEffect(() => {
    const scrollY = restoreBrowseScroll();
    if (scrollY != null) {
      window.scrollTo(0, scrollY);
    }
  }, []);

  const openDetails = (item: LibraryTitle) => {
    storeBrowseScroll(window.scrollY);
    setInspectorItem(item);
  };

  const openManage = (data: MovieDetails | TvDetails) => {
    setInspectorItem(null);
    setManagedTitle(
      'title' in data ? { data, mediaType: 'movie' } : { data, mediaType: 'tv' }
    );
  };

  useEffect(() => {
    return registerLibraryShelfRevalidator(async () => {
      await mutate();
    });
  }, [mutate]);

  const statusMessage =
    code === 'not_linked'
      ? intl.formatMessage(messages.notLinked)
      : code === 'unsupported_media_server'
        ? intl.formatMessage(messages.unsupported)
        : code === 'server_unreachable'
          ? intl.formatMessage(messages.unreachable)
          : null;

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.browse)} />
      <div className="mb-4 flex flex-col justify-between gap-3 lg:flex-row lg:items-end">
        <div>
          <Header>{intl.formatMessage(messages.library)}</Header>
          <p className="mt-1 text-sm text-gray-400">
            {intl.formatMessage(messages.subtitle)}
          </p>
        </div>
        <LibraryModeNav />
      </div>
      {statusMessage ? (
        <p className="rounded-md border border-gray-700 bg-library-charcoal px-4 py-3 text-sm text-gray-300">
          {statusMessage}
        </p>
      ) : (
        <>
          <LibraryBrowseToolbar
            query={searchInput}
            onQueryChange={setSearchInput}
            state={state}
            density={state.density}
            resultCount={total}
            onChange={applyPatch}
            onDensityChange={(density) => {
              storeDensity(density);
              void router.replace(
                {
                  pathname: '/library/browse',
                  query: paramsFromState({ ...state, density }),
                },
                undefined,
                { shallow: true }
              );
            }}
            onOpenFilters={() => setFiltersOpen(true)}
          />
          <LibraryBrowseFilters
            show={filtersOpen}
            onClose={() => setFiltersOpen(false)}
            state={state}
            genres={facets?.genres ?? []}
            yearMin={facets?.yearMin}
            yearMax={facets?.yearMax}
            onChange={applyPatch}
            onReset={() =>
              applyPatch({
                watched: undefined,
                genre: undefined,
                yearFrom: undefined,
                yearTo: undefined,
              })
            }
          />
          {loadingInitial ? (
            <LoadingSpinner />
          ) : (
            <LibraryBrowseGrid
              items={items}
              density={state.density}
              loading={loadingMore}
              error={Boolean(error)}
              reachedEnd={reachedEnd}
              onRetry={() => {
                void mutate();
              }}
              onOpen={openDetails}
              sentinelRef={sentinelRef}
            />
          )}
        </>
      )}
      {!managedTitle ? (
        <LibraryInspector
          item={inspectorItem}
          onClose={() => setInspectorItem(null)}
          onManage={openManage}
        />
      ) : null}
      {managedTitle?.mediaType === 'movie' ? (
        <ManageSlideOver
          show
          data={managedTitle.data}
          mediaType="movie"
          revalidate={() => {
            void mutate();
          }}
          onClose={() => setManagedTitle(null)}
        />
      ) : managedTitle?.mediaType === 'tv' ? (
        <ManageSlideOver
          show
          data={managedTitle.data}
          mediaType="tv"
          revalidate={() => {
            void mutate();
          }}
          onClose={() => setManagedTitle(null)}
        />
      ) : null}
    </>
  );
};

export default LibraryBrowse;
