import {
  blocklistPageSizes,
  blocklistPath,
  parseBlocklistQuery,
  type BlocklistQueryState,
  type BlocklistSource,
} from '@app/components/Blocklist/queryState';
import BlocklistedTagsBadge from '@app/components/BlocklistedTagsBadge';
import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import Header from '@app/components/Common/Header';
import LinkButton from '@app/components/Common/LinkButton';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowPathIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  EyeSlashIcon,
  MagnifyingGlassIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/solid';
import type {
  BlocklistItem,
  BlocklistResultsResponse,
} from '@server/interfaces/api/blocklistInterfaces';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import axios from 'axios';
import { useEffect, useId, useMemo, useState } from 'react';
import { useInView } from 'react-intersection-observer';
import { FormattedRelativeTime, useIntl } from 'react-intl';
import { Link, useLocation, useNavigate } from 'react-router';
import useSWR from 'swr';

const messages = defineMessages('components.Blocklist', {
  blocklistsettings: 'Blocklist Settings',
  blocklistSettingsDescription: 'Manage blocklisted media.',
  mediaName: 'Name',
  mediaType: 'Type',
  mediaTmdbId: 'tmdb Id',
  blocklistdate: 'date',
  blocklistedby: '{date} by {user}',
  blocklistNotFoundError: '<strong>{title}</strong> is not blocklisted.',
  filterManual: 'Manual',
  unknownTitle: 'Title {id}',
  tagRemovalHint: 'Removing this title does not remove the matching tag rules.',
  description:
    'Manage titles excluded from requests. Review manual blocks and titles matched by your tag rules.',
  source: 'Blocked by',
  allSources: 'All sources',
  search: 'Search titles',
  searchPlaceholder: 'Movie or series name',
  clearSearch: 'Clear search',
  clearFilters: 'Clear filters',
  refresh: 'Refresh',
  tagSettings: 'Tag rules',
  allHint: 'Showing manual blocks and tag matches.',
  manualHint: 'Titles added directly to the blocklist.',
  tagsHint:
    'Titles matched by configured content tags. Removing a title does not change those rules.',
  resultCount:
    '{count, plural, one {# blocked title} other {# blocked titles}}',
  noMatches: 'No blocked titles match these filters',
  noMatchesHint: 'Try another title or clear the search and source filter.',
  empty: 'No titles are blocklisted',
  emptyHint: 'Titles added manually or matched by tag rules will appear here.',
  emptyPage: 'No titles on this page',
  firstPage: 'Go to first page',
  page: 'Page {page} of {total}',
  pageSize: 'Per page',
  pagination: 'Blocklist pagination',
  loadError: 'Could not load the blocklist. Try again.',
  retry: 'Try again',

  filterBlocklistedTags: 'Blocklisted Tags',
  showAllBlocklisted: 'Show All Blocklisted Media',
});

const isMovie = (movie: MovieDetails | TvDetails): movie is MovieDetails => {
  return (movie as MovieDetails).title !== undefined;
};

const Blocklist = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const intl = useIntl();
  const { hasPermission } = useUser();
  const state = useMemo(
    () => parseBlocklistQuery(location.search),
    [location.search]
  );
  const [searchInput, setSearchInput] = useState(state.q);
  useEffect(() => setSearchInput(state.q), [state.q]);
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (searchInput.trim() !== state.q)
        navigate(blocklistPath({ ...state, q: searchInput.trim(), page: 1 }), {
          replace: true,
        });
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [navigate, searchInput, state]);

  const applyPatch = (patch: Partial<BlocklistQueryState>) =>
    navigate(blocklistPath({ ...state, q: searchInput.trim(), ...patch }));
  const clearFilters = () => {
    setSearchInput('');
    applyPatch({ filter: 'all', q: '', page: 1 });
  };
  const {
    data,
    error,
    isValidating,
    mutate: revalidate,
  } = useSWR<BlocklistResultsResponse>(
    `/api/v1/blocklist/?take=${state.pageSize}&skip=${(state.page - 1) * state.pageSize}&filter=${state.filter}${state.q ? `&search=${encodeURIComponent(state.q)}` : ''}`,
    { refreshInterval: 0, revalidateOnFocus: false }
  );
  const hasFilters = state.filter !== 'all' || Boolean(searchInput.trim());
  const sourceDescription =
    state.filter === 'manual'
      ? messages.manualHint
      : state.filter === 'blocklistedTags'
        ? messages.tagsHint
        : messages.allHint;

  return (
    <>
      <PageTitle title={[intl.formatMessage(globalMessages.blocklist)]} />
      <div className="mb-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Header>{intl.formatMessage(globalMessages.blocklist)}</Header>
          <div className="mt-6 flex flex-wrap gap-2">
            <Button
              type="button"
              buttonType="ghost"
              className="min-h-[44px]"
              disabled={isValidating}
              onClick={() => void revalidate()}
            >
              <ArrowPathIcon />
              <span>{intl.formatMessage(messages.refresh)}</span>
            </Button>
            {hasPermission(Permission.ADMIN) && (
              <LinkButton
                to="/settings/main#blocklist-tags"
                buttonType="ghost"
                className="min-h-[44px]"
              >
                {intl.formatMessage(messages.tagSettings)}
              </LinkButton>
            )}
          </div>
        </div>
        <p className="max-w-3xl text-sm leading-6 text-gray-400">
          {intl.formatMessage(messages.description)}
        </p>
        <div className="flex flex-col gap-3 rounded-xl border border-gray-700 bg-gray-800/50 p-4 sm:flex-row sm:items-end">
          <div className="sm:w-56">
            <label
              htmlFor="blocklist-source"
              className="mb-2 block text-sm font-medium text-gray-300"
            >
              {intl.formatMessage(messages.source)}
            </label>
            <select
              id="blocklist-source"
              value={state.filter}
              className="min-h-[44px] w-full"
              onChange={(event) =>
                applyPatch({
                  filter: event.target.value as BlocklistSource,
                  page: 1,
                })
              }
            >
              <option value="all">
                {intl.formatMessage(messages.allSources)}
              </option>
              <option value="manual">
                {intl.formatMessage(messages.filterManual)}
              </option>
              <option value="blocklistedTags">
                {intl.formatMessage(messages.filterBlocklistedTags)}
              </option>
            </select>
          </div>
          <div className="min-w-0 flex-1">
            <label
              htmlFor="blocklist-search"
              className="mb-2 block text-sm font-medium text-gray-300"
            >
              {intl.formatMessage(messages.search)}
            </label>
            <div className="relative">
              <MagnifyingGlassIcon
                aria-hidden="true"
                className="pointer-events-none absolute left-3 top-3 h-5 w-5 text-gray-400"
              />
              <input
                id="blocklist-search"
                type="search"
                placeholder={intl.formatMessage(messages.searchPlaceholder)}
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                className="min-h-[44px] w-full pl-10 pr-12"
              />
              {searchInput && (
                <button
                  type="button"
                  aria-label={intl.formatMessage(messages.clearSearch)}
                  onClick={() => {
                    setSearchInput('');
                    applyPatch({ q: '', page: 1 });
                  }}
                  className="absolute inset-y-0 right-0 flex min-w-[44px] items-center justify-center rounded-r-md text-gray-400 hover:text-white focus-visible:ring-2 focus-visible:ring-indigo-400"
                >
                  <XMarkIcon className="h-5 w-5" />
                </button>
              )}
            </div>
          </div>
          {hasFilters && (
            <Button
              type="button"
              buttonType="ghost"
              className="min-h-[44px]"
              onClick={clearFilters}
            >
              {intl.formatMessage(messages.clearFilters)}
            </Button>
          )}
        </div>
        <p className="text-sm leading-6 text-gray-400">
          {intl.formatMessage(sourceDescription)}
        </p>
      </div>
      {error && (
        <div className="mb-5 space-y-3">
          <Alert type="error" title={intl.formatMessage(messages.loadError)} />
          <Button
            type="button"
            className="min-h-[44px]"
            onClick={() => void revalidate()}
          >
            {intl.formatMessage(messages.retry)}
          </Button>
        </div>
      )}
      {!data && !error ? (
        <LoadingSpinner />
      ) : (
        data && (
          <>
            <div role="status" className="mb-3 text-sm text-gray-400">
              {intl.formatMessage(messages.resultCount, {
                count: data.pageInfo.results,
              })}
            </div>
            {data.results.length === 0 ? (
              <div className="rounded-xl border border-gray-700 bg-gray-800/50 px-5 py-10 text-center">
                <EyeSlashIcon
                  aria-hidden="true"
                  className="mx-auto mb-4 h-10 w-10 text-gray-500"
                />
                <h2 className="text-lg font-semibold text-white">
                  {intl.formatMessage(
                    hasFilters
                      ? messages.noMatches
                      : state.page > 1
                        ? messages.emptyPage
                        : messages.empty
                  )}
                </h2>
                <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-gray-400">
                  {intl.formatMessage(
                    hasFilters ? messages.noMatchesHint : messages.emptyHint
                  )}
                </p>
                {hasFilters ? (
                  <Button
                    type="button"
                    className="mt-5 min-h-[44px]"
                    onClick={clearFilters}
                  >
                    {intl.formatMessage(messages.clearFilters)}
                  </Button>
                ) : (
                  state.page > 1 && (
                    <Button
                      type="button"
                      className="mt-5 min-h-[44px]"
                      onClick={() => applyPatch({ page: 1 })}
                    >
                      {intl.formatMessage(messages.firstPage)}
                    </Button>
                  )
                )}
              </div>
            ) : (
              <div className="space-y-3">
                {data.results.map((item) => (
                  <BlocklistedItem
                    key={`${item.mediaType}-${item.tmdbId}`}
                    item={item}
                    revalidateList={revalidate}
                  />
                ))}
              </div>
            )}
            {(data.pageInfo.results > 0 || state.page > 1) && (
              <nav
                aria-label={intl.formatMessage(messages.pagination)}
                className="my-6 flex flex-wrap items-center justify-between gap-4"
              >
                <p className="text-sm text-gray-400">
                  {intl.formatMessage(messages.page, {
                    page: state.page,
                    total: Math.max(1, data.pageInfo.pages),
                  })}
                </p>
                <label
                  className="flex items-center gap-2 text-sm text-gray-400"
                  htmlFor="blocklist-page-size"
                >
                  {intl.formatMessage(messages.pageSize)}
                  <select
                    id="blocklist-page-size"
                    value={state.pageSize}
                    className="short min-h-[44px]"
                    onChange={(event) => {
                      applyPatch({
                        pageSize: Number(event.target.value),
                        page: 1,
                      });
                      window.scrollTo(0, 0);
                    }}
                  >
                    {blocklistPageSizes.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    className="min-h-[44px]"
                    disabled={state.page <= 1}
                    onClick={() => applyPatch({ page: state.page - 1 })}
                  >
                    <ChevronLeftIcon />
                    <span>{intl.formatMessage(globalMessages.previous)}</span>
                  </Button>
                  <Button
                    type="button"
                    className="min-h-[44px]"
                    disabled={state.page >= data.pageInfo.pages}
                    onClick={() => applyPatch({ page: state.page + 1 })}
                  >
                    <span>{intl.formatMessage(globalMessages.next)}</span>
                    <ChevronRightIcon />
                  </Button>
                </div>
              </nav>
            )}
          </>
        )
      )}
    </>
  );
};

export default Blocklist;

interface BlocklistedItemProps {
  item: BlocklistItem;
  revalidateList: () => void;
}

const BlocklistedItem = ({ item, revalidateList }: BlocklistedItemProps) => {
  const [isUpdating, setIsUpdating] = useState<boolean>(false);
  const { addToast } = useToasts();
  const { ref, inView } = useInView({
    triggerOnce: true,
  });
  const intl = useIntl();
  const { hasPermission } = useUser();

  const url =
    item.mediaType === 'movie'
      ? `/api/v1/movie/${item.tmdbId}`
      : `/api/v1/tv/${item.tmdbId}`;
  const { data: title } = useSWR<MovieDetails | TvDetails>(inView ? url : null);

  const removeFromBlocklist = async (tmdbId: number, title?: string) => {
    setIsUpdating(true);

    try {
      await axios.delete(
        `/api/v1/blocklist/${tmdbId}?mediaType=${item.mediaType}`
      );

      addToast(
        <span>
          {intl.formatMessage(globalMessages.removeFromBlocklistSuccess, {
            title,
            strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
          })}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );
    } catch {
      addToast(intl.formatMessage(globalMessages.blocklistError), {
        appearance: 'error',
        autoDismiss: true,
      });
    }

    revalidateList();
    setIsUpdating(false);
  };

  const titleName = title
    ? isMovie(title)
      ? title.title
      : title.name
    : item.title ||
      intl.formatMessage(messages.unknownTitle, { id: item.tmdbId });
  const titleId = useId();
  const titlePath = `/${item.mediaType === 'movie' ? 'movie' : 'tv'}/${item.tmdbId}`;
  const year =
    title &&
    (isMovie(title) ? title.releaseDate : title.firstAirDate)?.slice(0, 4);

  return (
    <article
      ref={ref}
      className="rounded-xl border border-gray-700 bg-gray-800/70 p-4 shadow-sm"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <div className="flex min-w-0 flex-1 gap-3">
          <Link
            to={titlePath}
            aria-label={titleName}
            className="relative block h-24 w-16 shrink-0 overflow-hidden rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
          >
            <CachedImage
              type="tmdb"
              src={
                title?.posterPath
                  ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${title.posterPath}`
                  : '/images/seerr_poster_not_found.png'
              }
              alt=""
              fill
              style={{ objectFit: 'cover' }}
            />
          </Link>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-gray-400">
              <span>
                {intl.formatMessage(
                  item.mediaType === 'movie'
                    ? globalMessages.movie
                    : globalMessages.tvshow
                )}
              </span>
              {year && <span>{year}</span>}
            </div>
            <h3
              id={titleId}
              className="break-words text-lg font-semibold leading-7 text-white"
            >
              <Link
                to={titlePath}
                className="rounded hover:text-indigo-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
              >
                {titleName}
              </Link>
            </h3>
            <div className="mt-2">
              {item.blocklistedTags ? (
                <BlocklistedTagsBadge data={item} showDetails />
              ) : (
                <Badge badgeType="dark">
                  {intl.formatMessage(messages.filterManual)}
                </Badge>
              )}
            </div>
            {item.createdAt && (
              <div
                className="mt-2 flex flex-wrap items-center gap-x-1 text-xs leading-5 text-gray-400"
                title={intl.formatDate(item.createdAt, {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              >
                <FormattedRelativeTime
                  value={Math.floor(
                    (new Date(item.createdAt).getTime() - Date.now()) / 1000
                  )}
                  updateIntervalInSeconds={60}
                  numeric="auto"
                />
                {item.user &&
                  intl.formatMessage(messages.blocklistedby, {
                    date: '',
                    user: (
                      <Link
                        to={`/users/${item.user.id}`}
                        className="break-words font-medium text-gray-300 hover:text-white hover:underline"
                      >
                        {item.user.displayName}
                      </Link>
                    ),
                  })}
              </div>
            )}
          </div>
        </div>
        {hasPermission(Permission.MANAGE_BLOCKLIST) && (
          <div className="w-full shrink-0 space-y-2 sm:w-56">
            <ConfirmButton
              disabled={isUpdating}
              aria-busy={isUpdating}
              aria-describedby={titleId}
              onClick={() => void removeFromBlocklist(item.tmdbId, titleName)}
              confirmText={intl.formatMessage(
                isUpdating ? globalMessages.deleting : globalMessages.areyousure
              )}
              className="min-h-[44px] w-full"
            >
              <TrashIcon />
              <span>
                {intl.formatMessage(globalMessages.removefromBlocklist)}
              </span>
            </ConfirmButton>
            {item.blocklistedTags && (
              <p className="text-xs leading-5 text-gray-400">
                {intl.formatMessage(messages.tagRemovalHint)}
              </p>
            )}
          </div>
        )}
      </div>
    </article>
  );
};
