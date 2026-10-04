import Button from '@app/components/Common/Button';
import EmptyState from '@app/components/Common/EmptyState';
import Header from '@app/components/Common/Header';
import LinkButton from '@app/components/Common/LinkButton';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import LibraryBrowseFilters from '@app/components/Library/LibraryBrowseFilters';
import LibraryBrowseGrid from '@app/components/Library/LibraryBrowseGrid';
import LibraryBrowseToolbar from '@app/components/Library/LibraryBrowseToolbar';
import LibraryInspector from '@app/components/Library/LibraryInspector';
import {
  browseStateFromQuery,
  libraryBrowseApiPath,
  mergeBrowsePatch,
  restoreBrowseScroll,
  serializeBrowseApiQuery,
  serializeBrowseState,
  storeBrowseScroll,
  storeDensity,
} from '@app/components/Library/browseUrlState';
import useLibraryInfiniteScroll from '@app/components/Library/useLibraryInfiniteScroll';
import ManageSlideOver from '@app/components/ManageSlideOver';
import useRouteQuery from '@app/hooks/useRouteQuery';
import defineMessages from '@app/utils/defineMessages';
import { registerLibraryShelfRevalidator } from '@app/utils/mediaActionInvalidation';
import { buildPath } from '@app/utils/routing';
import {
  ExclamationTriangleIcon,
  LinkIcon,
  ServerIcon,
} from '@heroicons/react/24/outline';
import type {
  LibraryBrowseResponse,
  LibraryFacetsResponse,
  LibraryTitle,
} from '@server/interfaces/api/libraryInterfaces';
import {
  countActiveLibraryBrowseFilters,
  type ParsedLibraryBrowseQuery,
} from '@server/lib/libraryBrowseQuery';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useLocation, useNavigate } from 'react-router';
import useSWR from 'swr';
import useSWRInfinite from 'swr/infinite';

const PAGE_SIZE = 24;

const messages = defineMessages('components.Library.LibraryBrowse', {
  library: 'Library',
  browse: 'Browse',
  subtitle: 'Search and filter everything in your Jellyfin library.',
  notLinkedTitle: 'Jellyfin account not linked',
  notLinked: 'Link your Jellyfin account in settings to browse your library.',
  linkAccount: 'Link Account',
  unsupportedTitle: 'Library needs Jellyfin',
  unsupported: 'Complete Library browse requires a Jellyfin media server.',
  unreachable: 'Could not reach Jellyfin.',
  unreachableDescription:
    'Check that your Jellyfin server is running, then try again.',
  retry: 'Retry',
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
  const navigate = useNavigate();
  const location = useLocation();
  const routeQuery = useRouteQuery();
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [inspectorItem, setInspectorItem] = useState<LibraryTitle | null>(null);
  const [managedTitle, setManagedTitle] = useState<
    | { data: MovieDetails; mediaType: 'movie' }
    | { data: TvDetails; mediaType: 'tv' }
    | null
  >(null);
  const [showManager, setShowManager] = useState(false);
  const [searchInput, setSearchInput] = useState('');

  const state = useMemo(() => browseStateFromQuery(routeQuery), [routeQuery]);

  useEffect(() => {
    setSearchInput(state.q ?? '');
  }, [state.q]);

  useEffect(() => {
    const handle = window.setTimeout(() => {
      const next = searchInput.trim();
      if (next === (state.q ?? '')) {
        return;
      }
      void navigate(
        buildPath(
          '/library/browse',
          paramsFromState({ ...state, q: next || undefined, skip: 0 })
        ),
        { replace: true }
      );
    }, 300);
    return () => window.clearTimeout(handle);
  }, [navigate, searchInput, state]);

  const applyPatch = (patch: Partial<ParsedLibraryBrowseQuery>) => {
    void navigate(
      buildPath(
        '/library/browse',
        paramsFromState(mergeBrowsePatch(state, patch, searchInput))
      ),
      { replace: true }
    );
  };

  const resetFilters = () =>
    applyPatch({
      watched: undefined,
      genre: undefined,
      yearFrom: undefined,
      yearTo: undefined,
    });

  const resetBrowse = () => {
    setSearchInput('');
    applyPatch({
      q: '',
      mediaType: undefined,
      watched: undefined,
      genre: undefined,
      yearFrom: undefined,
      yearTo: undefined,
    });
  };

  const {
    data: facets,
    error: facetsError,
    isValidating: facetsLoading,
    mutate: retryFacets,
  } = useSWR<LibraryFacetsResponse>(
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
      return libraryBrowseApiPath({
        ...state,
        take: PAGE_SIZE,
        skip: pageIndex * PAGE_SIZE,
      });
    },
    { revalidateFirstPage: false }
  );

  useEffect(() => {
    setSize(1);
  }, [scopeKey, setSize]);

  const items = pages?.flatMap((page) => page.results) ?? [];
  const code = pages?.[0]?.code ?? facets?.code;
  const pageError = Boolean(
    error || pages?.some((page) => page.code === 'server_unreachable')
  );
  const total = pages?.[0]?.pageInfo.results;
  const lastPage = pages?.[pages.length - 1];
  const reachedEnd =
    !lastPage || lastPage.pageInfo.page >= lastPage.pageInfo.pages;
  const loadingInitial = !pages && !error;
  const loadingMore =
    isValidating && !!pages && typeof pages[size - 1] === 'undefined';

  const loadMore = useCallback(() => {
    if (!isValidating && !reachedEnd && !pageError) {
      void setSize((current) => current + 1).catch(() => undefined);
    }
  }, [pageError, isValidating, reachedEnd, setSize]);

  useLibraryInfiniteScroll(
    sentinelRef,
    loadMore,
    !loadingInitial && !loadingMore && !reachedEnd && !pageError
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
    setShowManager(true);
  };

  useEffect(() => {
    return registerLibraryShelfRevalidator(async () => {
      await mutate();
    });
  }, [mutate]);

  const status =
    code === 'not_linked'
      ? {
          icon: LinkIcon,
          title: intl.formatMessage(messages.notLinkedTitle),
          description: intl.formatMessage(messages.notLinked),
          action: (
            <LinkButton
              className="min-h-11"
              to="/profile/settings/linked-accounts"
              buttonType="primary"
            >
              <LinkIcon />
              <span>{intl.formatMessage(messages.linkAccount)}</span>
            </LinkButton>
          ),
        }
      : code === 'unsupported_media_server'
        ? {
            icon: ServerIcon,
            title: intl.formatMessage(messages.unsupportedTitle),
            description: intl.formatMessage(messages.unsupported),
          }
        : code === 'server_unreachable' && !items.length
          ? {
              icon: ExclamationTriangleIcon,
              title: intl.formatMessage(messages.unreachable),
              description: intl.formatMessage(messages.unreachableDescription),
              action: (
                <Button
                  className="min-h-11"
                  aria-disabled={isValidating}
                  onClick={() => {
                    if (!isValidating) void mutate().catch(() => undefined);
                  }}
                >
                  {intl.formatMessage(messages.retry)}
                </Button>
              ),
            }
          : null;

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.browse),
          intl.formatMessage(messages.library),
        ]}
      />
      <div className="mb-4">
        <Header subtext={intl.formatMessage(messages.subtitle)}>
          {intl.formatMessage(messages.library)}
        </Header>
      </div>
      {status ? (
        <div className="mt-6">
          <EmptyState
            icon={status.icon}
            title={status.title}
            description={status.description}
            action={status.action}
          />
        </div>
      ) : (
        <>
          <LibraryBrowseToolbar
            focusSearch={location.hash === '#library-search'}
            query={searchInput}
            onQueryChange={(value) => {
              setSearchInput(value);
              if (!value.trim()) applyPatch({ q: '', skip: 0 });
            }}
            state={state}
            density={state.density}
            resultCount={total}
            onChange={applyPatch}
            onDensityChange={(density) => {
              storeDensity(density);
              void navigate(
                buildPath(
                  '/library/browse',
                  paramsFromState({
                    ...mergeBrowsePatch(state, {}, searchInput),
                    density,
                  })
                ),
                { replace: true }
              );
            }}
            onOpenFilters={() => setFiltersOpen(true)}
            onResetFilters={resetFilters}
          />
          <LibraryBrowseFilters
            show={filtersOpen}
            onClose={() => setFiltersOpen(false)}
            state={state}
            genres={facets?.genres ?? []}
            yearMin={facets?.yearMin}
            yearMax={facets?.yearMax}
            resultCount={total}
            loadingResults={loadingInitial || isValidating}
            genresLoading={facetsLoading}
            genresError={Boolean(
              facetsError || facets?.code === 'server_unreachable'
            )}
            onRetryGenres={() => void retryFacets().catch(() => undefined)}
            onChange={applyPatch}
            onReset={resetFilters}
          />
          {loadingInitial ? (
            <LoadingSpinner />
          ) : (
            <LibraryBrowseGrid
              items={items}
              density={state.density}
              loading={loadingMore}
              busy={isValidating}
              totalCount={total}
              error={pageError}
              reachedEnd={reachedEnd}
              onRetry={() => {
                void mutate().catch(() => undefined);
              }}
              onLoadMore={loadMore}
              onOpen={openDetails}
              hasFilters={Boolean(
                state.q ||
                state.mediaType ||
                countActiveLibraryBrowseFilters(state)
              )}
              onReset={resetBrowse}
              sentinelRef={sentinelRef}
            />
          )}
        </>
      )}
      <LibraryInspector
        item={inspectorItem}
        onClose={() => setInspectorItem(null)}
        onManage={openManage}
      />
      {managedTitle?.mediaType === 'movie' ? (
        <ManageSlideOver
          show={showManager}
          data={managedTitle.data}
          mediaType="movie"
          revalidate={() => {
            void mutate();
          }}
          onClose={() => setShowManager(false)}
        />
      ) : managedTitle?.mediaType === 'tv' ? (
        <ManageSlideOver
          show={showManager}
          data={managedTitle.data}
          mediaType="tv"
          revalidate={() => {
            void mutate();
          }}
          onClose={() => setShowManager(false)}
        />
      ) : null}
    </>
  );
};

export default LibraryBrowse;
