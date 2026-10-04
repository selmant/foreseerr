import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import EmptyState from '@app/components/Common/EmptyState';
import Header from '@app/components/Common/Header';
import LinkButton from '@app/components/Common/LinkButton';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import SegmentedControl from '@app/components/Common/SegmentedControl';
import SlideOver from '@app/components/Common/SlideOver';
import InterventionImport from '@app/components/ServarrInterventions/InterventionImport';
import type { InterventionState } from '@app/components/ServarrInterventions/queryState';
import {
  parseInterventionState,
  updateInterventionSearch,
} from '@app/components/ServarrInterventions/queryState';
import type {
  InterventionResults,
  ServarrIntervention,
} from '@app/components/ServarrInterventions/types';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  Description,
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
} from '@headlessui/react';
import {
  ArrowDownTrayIcon,
  CheckCircleIcon,
  Cog6ToothIcon,
  NoSymbolIcon,
} from '@heroicons/react/24/outline';
import {
  ArrowPathIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FilmIcon,
  TvIcon,
} from '@heroicons/react/24/solid';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import axios from 'axios';
import { Children, useEffect, useId, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import { Link, useSearchParams } from 'react-router';
import useSWR, { mutate } from 'swr';

const TAKE = 25;

const messages = defineMessages('components.ServarrInterventions', {
  title: 'Interventions',
  description:
    'Review Sonarr and Radarr download warnings and resolve blocked imports.',
  active: 'Active',
  history: 'Blocklist history',
  allServices: 'All',
  allTypes: 'All',
  emptyActive: 'No active warnings.',
  emptyHistory: 'No Foreseerr blocklist history.',
  loadError: 'Unable to load interventions.',
  firstSeen: 'First seen {date}',
  overdue: 'Automatic rejection due',
  remaining: 'Automatic rejection in {hours}h {minutes}m',
  cleanupError: 'Last cleanup error: {error}',
  automaticCleanup: 'Automatic Cleanup',
  manualRejection: 'Manual rejection{actor}',
  byActor: ' by {name}',
  manualImport: 'Manual Import',
  reject: 'Reject and Blocklist',
  rejecting: 'Rejecting…',
  importing: 'Importing…',
  inProgress: 'In Progress',
  rejectConfirm: 'Delete this download and blocklist the release in {service}?',
  rejectTitle: 'Reject this release?',
  rejectExplanation:
    'This deletes the download and blocklists the release in {service}, allowing the service to try another release.',
  rejected: 'Release rejected and blocklisted.',
  rejectFailed: 'Rejection failed.',
  mode: 'Interventions view',
  activeCount: 'Active ({count})',
  emptyActiveDescription:
    'Queue warnings from mapped Sonarr and Radarr downloads will appear here.',
  emptyHistoryDescription:
    'Releases Foreseerr rejects and blocklists will be listed here.',
  activeHelp:
    'Use Manual Import to choose files to add to your library. Reject and Blocklist removes the download and prevents this release from being grabbed again.',
  historyHelp:
    'Releases blocklisted by Foreseerr, with the time and reason for each action.',
  actionGuide: 'How to resolve warnings',
  historyGuide: 'About blocklist history',
  cleanupEnabled:
    'Automatic cleanup is on. Overdue warnings will be rejected and blocklisted.',
  cleanupDisabled:
    'Automatic cleanup is off. Warnings will not be rejected automatically.',
  cleanupUnknown: 'Automatic cleanup runs only when enabled in settings.',
  cleanupSettings: 'Cleanup settings',
  refresh: 'Refresh',
  serviceFilter: 'Service',
  mediaFilter: 'Media type',
  clearFilters: 'Clear filters',
  filteredEmpty: 'No warnings match these filters.',
  filteredHistoryEmpty: 'No blocklisted releases match these filters.',
  filteredEmptyDescription:
    'Try another service or media type, or clear the filters to see everything.',
  warnings: '{count, plural, one {# warning} other {# warnings}}',
  blocklisted:
    '{count, plural, one {# blocklisted release} other {# blocklisted releases}}',
  warningReason: 'Why this needs attention',
  historicalWarning: 'Warning at the time of rejection',
  noWarningReason:
    'The service has reported a download warning without further details.',
  reviewFiles:
    'Review the downloaded files and their assignments before importing.',
  importUnavailable:
    'Manual import becomes available when {service} reports a completed download and its file location. Open Manage downloads to review its progress or find another release.',
  manageDownloads: 'Manage downloads',
  importRelease: 'Manual Import: {release}',
  rejectRelease: 'Reject and Blocklist: {release}',
  manageRelease: 'Manage downloads: {release}',
});

const InterventionTitle = ({ item }: { item: ServarrIntervention }) => {
  const intl = useIntl();
  const { data } = useSWR<MovieDetails | TvDetails>(
    `/api/v1/${item.mediaType}/${item.tmdbId}`
  );
  const title = data
    ? 'title' in data
      ? data.title
      : data.name
    : intl.formatMessage(
        item.mediaType === 'movie'
          ? globalMessages.movie
          : globalMessages.tvshow
      );
  return (
    <Link
      to={`/${item.mediaType}/${item.tmdbId}`}
      className="inline-flex min-h-11 items-center break-words text-base font-semibold text-white transition hover:underline"
    >
      {title}
    </Link>
  );
};

const InterventionPoster = ({ item }: { item: ServarrIntervention }) => {
  // Shares the SWR key with InterventionTitle, so this adds no request.
  const { data } = useSWR<MovieDetails | TvDetails>(
    `/api/v1/${item.mediaType}/${item.tmdbId}`
  );
  const Icon = item.mediaType === 'movie' ? FilmIcon : TvIcon;
  return (
    <Link
      to={`/${item.mediaType}/${item.tmdbId}`}
      className="relative hidden h-24 w-16 flex-none overflow-hidden rounded-md bg-gray-700 ring-1 ring-gray-700 transition hover:opacity-80 sm:block"
      aria-hidden
      tabIndex={-1}
    >
      {data?.posterPath ? (
        <CachedImage
          type="tmdb"
          src={`https://image.tmdb.org/t/p/w300_and_h450_face${data.posterPath}`}
          alt=""
          fill
          sizes="64px"
          className="object-cover"
        />
      ) : (
        <Icon className="absolute inset-0 m-auto h-6 w-6 text-gray-500" />
      )}
    </Link>
  );
};

const Countdown = ({ deadline }: { deadline: string }) => {
  const intl = useIntl();
  const remaining = new Date(deadline).getTime() - Date.now();
  if (remaining <= 0) {
    return (
      <Badge badgeType="danger">{intl.formatMessage(messages.overdue)}</Badge>
    );
  }
  const hours = Math.floor(remaining / 3_600_000);
  const minutes = Math.floor((remaining % 3_600_000) / 60_000);
  return (
    <span>{intl.formatMessage(messages.remaining, { hours, minutes })}</span>
  );
};

const ServarrInterventions = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { hasPermission } = useUser();
  const serviceId = useId();
  const mediaId = useId();
  const [searchParams, setSearchParams] = useSearchParams();
  const { mode, page, serviceType, mediaType } = parseInterventionState(
    searchParams.toString()
  );
  const updateView = (changes: Partial<InterventionState>) =>
    setSearchParams((current) =>
      updateInterventionSearch(current.toString(), changes)
    );
  const [selected, setSelected] = useState<ServarrIntervention>();
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  const [rejectItem, setRejectItem] = useState<ServarrIntervention>();
  const { data: counts } = useSWR<{ active: number }>(
    '/api/v1/servarr/interventions/count'
  );
  const { data: cleanupSettings } = useSWR<{
    automaticCleanupEnabled: boolean;
  }>(
    hasPermission(Permission.ADMIN)
      ? '/api/v1/settings/servarr-interventions'
      : null
  );
  const hasFilters = Boolean(serviceType || mediaType);
  const clearFilters = () => {
    updateView({ serviceType: '', mediaType: '' });
  };
  const query = useMemo(
    () =>
      new URLSearchParams({
        mode,
        take: String(TAKE),
        skip: String(page * TAKE),
        ...(serviceType && { serviceType }),
        ...(mediaType && { mediaType }),
      }).toString(),
    [mediaType, mode, page, serviceType]
  );
  const {
    data,
    error,
    mutate: refresh,
    isValidating,
  } = useSWR<InterventionResults>(`/api/v1/servarr/interventions?${query}`, {
    refreshInterval:
      mode !== 'active'
        ? 0
        : (latest) =>
            pendingIds.size > 0 ||
            !!latest?.results.some(
              (item) => item.state === 'rejecting' || item.state === 'importing'
            )
              ? 3000
              : 60000,
  });

  useEffect(() => {
    // A resolved warning can remove the last page while someone is reviewing it.
    if (data && page > 0 && page >= data.pageInfo.pages) {
      setSearchParams(
        (current) =>
          updateInterventionSearch(current.toString(), {
            page: Math.max(0, data.pageInfo.pages - 1),
          }),
        { replace: true }
      );
    }
  }, [data, page, setSearchParams]);

  useEffect(() => {
    void axios
      .post('/api/v1/servarr/interventions/seen')
      .then(() => mutate('/api/v1/servarr/interventions/count'))
      .catch(() => undefined);
  }, []);

  const reject = async (item: ServarrIntervention) => {
    setPendingIds((current) => new Set(current).add(item.id));
    try {
      await axios.post(`/api/v1/servarr/interventions/${item.id}/reject`);
      addToast(intl.formatMessage(messages.rejected), {
        appearance: 'success',
        autoDismiss: true,
      });
      await Promise.all([
        refresh(),
        mutate('/api/v1/servarr/interventions/count'),
      ]);
    } catch (requestError) {
      addToast(
        axios.isAxiosError(requestError)
          ? (requestError.response?.data?.message ??
              intl.formatMessage(messages.rejectFailed))
          : intl.formatMessage(messages.rejectFailed),
        { appearance: 'error', autoDismiss: true }
      );
      await refresh();
    } finally {
      setPendingIds((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    }
  };

  const inProgress = (item: ServarrIntervention) =>
    item.state === 'rejecting' ||
    item.state === 'importing' ||
    pendingIds.has(item.id);

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.title)} />
      <div className="mb-4 flex flex-col justify-between lg:flex-row lg:items-end">
        <Header subtext={intl.formatMessage(messages.description)}>
          {intl.formatMessage(messages.title)}
        </Header>
        <SegmentedControl<'active' | 'history'>
          ariaLabel={intl.formatMessage(messages.mode)}
          className="mt-2 w-full lg:inline-grid lg:w-auto lg:min-w-[26rem]"
          value={mode}
          wrapLabels
          onChange={(value) => updateView({ mode: value })}
          options={[
            {
              value: 'active',
              label: counts
                ? intl.formatMessage(messages.activeCount, {
                    count: counts.active,
                  })
                : intl.formatMessage(messages.active),
            },
            { value: 'history', label: intl.formatMessage(messages.history) },
          ]}
        />
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {hasPermission(Permission.ADMIN) ? (
          <LinkButton
            to="/settings/integrations#intervention-cleanup"
            className="min-h-11 px-2.5 sm:px-4"
          >
            <Cog6ToothIcon />
            <span>{intl.formatMessage(messages.cleanupSettings)}</span>
          </LinkButton>
        ) : null}
        <Button
          className="min-h-11 px-2.5 sm:px-4"
          disabled={isValidating}
          onClick={() => void refresh()}
        >
          <ArrowPathIcon
            className={isValidating ? 'animate-spin' : undefined}
          />
          <span>{intl.formatMessage(messages.refresh)}</span>
        </Button>
      </div>
      <div className="mb-5 rounded-xl border border-gray-700 bg-gray-800/40 px-4 py-2 text-sm leading-6 text-gray-300">
        <details>
          <summary className="min-h-11 cursor-pointer rounded-md py-2.5 font-medium text-gray-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500">
            {intl.formatMessage(
              mode === 'active' ? messages.actionGuide : messages.historyGuide
            )}
          </summary>
          <p className="pb-3 pt-1">
            {intl.formatMessage(
              mode === 'active' ? messages.activeHelp : messages.historyHelp
            )}
          </p>
        </details>
        {mode === 'active' ? (
          <p className="mt-1 text-gray-400">
            {intl.formatMessage(
              !cleanupSettings
                ? messages.cleanupUnknown
                : cleanupSettings.automaticCleanupEnabled
                  ? messages.cleanupEnabled
                  : messages.cleanupDisabled
            )}
          </p>
        ) : null}
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-end">
        <div className="flex min-w-0 flex-col gap-1 sm:w-48">
          <label htmlFor={serviceId} className="text-sm text-gray-400">
            {intl.formatMessage(messages.serviceFilter)}
          </label>
          <select
            id={serviceId}
            value={serviceType}
            onChange={(event) =>
              updateView({ serviceType: event.target.value })
            }
            className="min-h-11 w-full min-w-0"
          >
            <option value="">{intl.formatMessage(messages.allServices)}</option>
            <option value="radarr">Radarr</option>
            <option value="sonarr">Sonarr</option>
          </select>
        </div>
        <div className="flex min-w-0 flex-col gap-1 sm:w-48">
          <label htmlFor={mediaId} className="text-sm text-gray-400">
            {intl.formatMessage(messages.mediaFilter)}
          </label>
          <select
            id={mediaId}
            value={mediaType}
            onChange={(event) => updateView({ mediaType: event.target.value })}
            className="min-h-11 w-full min-w-0"
          >
            <option value="">{intl.formatMessage(messages.allTypes)}</option>
            <option value="movie">
              {intl.formatMessage(globalMessages.movies)}
            </option>
            <option value="tv">
              {intl.formatMessage(globalMessages.tvshows)}
            </option>
          </select>
        </div>
        {hasFilters ? (
          <Button className="col-span-2 min-h-11" onClick={clearFilters}>
            {intl.formatMessage(messages.clearFilters)}
          </Button>
        ) : null}
        {data ? (
          <p
            role="status"
            className="col-span-2 py-1 text-sm text-gray-400 sm:ml-auto sm:py-3"
          >
            {intl.formatMessage(
              mode === 'active' ? messages.warnings : messages.blocklisted,
              { count: data.pageInfo.results }
            )}
          </p>
        ) : null}
      </div>
      {!data && !error && <LoadingSpinner />}
      {error && (
        <Alert type="error" title={intl.formatMessage(messages.loadError)}>
          <button
            className="min-h-11 underline underline-offset-4"
            onClick={() => void refresh()}
          >
            {intl.formatMessage(messages.refresh)}
          </button>
        </Alert>
      )}
      {data && (
        <div className="space-y-3">
          {data.results.length === 0 && (
            <EmptyState
              icon={mode === 'active' ? CheckCircleIcon : NoSymbolIcon}
              title={intl.formatMessage(
                hasFilters
                  ? mode === 'active'
                    ? messages.filteredEmpty
                    : messages.filteredHistoryEmpty
                  : mode === 'active'
                    ? messages.emptyActive
                    : messages.emptyHistory
              )}
              description={intl.formatMessage(
                hasFilters
                  ? messages.filteredEmptyDescription
                  : mode === 'active'
                    ? messages.emptyActiveDescription
                    : messages.emptyHistoryDescription
              )}
              action={
                hasFilters ? (
                  <Button
                    buttonType="primary"
                    className="min-h-11"
                    onClick={clearFilters}
                  >
                    {intl.formatMessage(messages.clearFilters)}
                  </Button>
                ) : undefined
              }
            />
          )}
          {data.results.map((item) => (
            <article
              key={item.id}
              className="rounded-xl bg-gray-800 p-4 shadow ring-1 ring-gray-700"
            >
              <div className="flex flex-wrap justify-between gap-4">
                <div className="flex min-w-0 flex-1 gap-4">
                  <InterventionPoster item={item} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="min-w-0">
                        <InterventionTitle item={item} />
                      </h2>
                      <Badge
                        badgeType="dark"
                        className="max-w-full whitespace-normal break-words"
                      >
                        {item.serviceName}
                        {item.is4k ? ' · 4K' : ''}
                      </Badge>
                      {inProgress(item) && (
                        <Badge badgeType="primary">
                          {intl.formatMessage(messages.inProgress)}
                        </Badge>
                      )}
                    </div>
                    <p
                      className="mt-1 break-all font-mono text-xs text-gray-400"
                      title={item.releaseTitle}
                    >
                      {item.releaseTitle}
                    </p>
                    <div className="mt-3 rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-3 text-sm">
                      <h3 className="mb-1 font-medium text-yellow-100">
                        {intl.formatMessage(
                          mode === 'active'
                            ? messages.warningReason
                            : messages.historicalWarning
                        )}
                      </h3>
                      {item.warningMessages.length > 0 ? (
                        <ul className="list-inside list-disc space-y-1 break-words text-yellow-200">
                          {item.warningMessages.map((message, index) => (
                            <li key={`${item.id}-${index}`}>{message}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-gray-300">
                          {intl.formatMessage(messages.noWarningReason)}
                        </p>
                      )}
                    </div>
                    {item.cleanupError && (
                      <div className="mt-2 break-words text-sm text-red-300">
                        {intl.formatMessage(messages.cleanupError, {
                          error: item.cleanupError,
                        })}
                      </div>
                    )}
                    <div className="mt-3 text-xs leading-6 text-gray-400">
                      {mode === 'active' ? (
                        <>
                          {intl.formatMessage(messages.firstSeen, {
                            date: intl.formatDate(item.firstSeenAt, {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            }),
                          })}
                          {cleanupSettings?.automaticCleanupEnabled && (
                            <>
                              {' · '}
                              <Countdown deadline={item.cleanupDeadlineAt} />
                            </>
                          )}
                        </>
                      ) : (
                        <>
                          {item.resolvedAt
                            ? intl.formatDate(item.resolvedAt, {
                                dateStyle: 'medium',
                                timeStyle: 'short',
                              })
                            : ''}{' '}
                          ·{' '}
                          {item.resolution === 'automatic_blocklist'
                            ? intl.formatMessage(messages.automaticCleanup)
                            : intl.formatMessage(messages.manualRejection, {
                                actor: item.actor
                                  ? intl.formatMessage(messages.byActor, {
                                      name: item.actor.displayName,
                                    })
                                  : '',
                              })}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
              {mode === 'active' && (
                <div className="mt-4 flex flex-col gap-3 border-t border-gray-700 pt-4 lg:flex-row lg:items-center lg:justify-between">
                  {!inProgress(item) && (
                    <p className="max-w-2xl text-sm leading-6 text-gray-400">
                      {intl.formatMessage(
                        item.manualImportCapable
                          ? messages.reviewFiles
                          : messages.importUnavailable,
                        { service: item.serviceName }
                      )}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2 lg:shrink-0">
                    <LinkButton
                      to={`/${item.mediaType}/${item.tmdbId}?manage=1`}
                      className="min-h-11"
                      aria-label={intl.formatMessage(messages.manageRelease, {
                        release: item.releaseTitle,
                      })}
                    >
                      <Cog6ToothIcon />
                      <span>
                        {intl.formatMessage(messages.manageDownloads)}
                      </span>
                    </LinkButton>
                    {item.manualImportCapable && (
                      <Button
                        buttonType="primary"
                        className="min-h-11"
                        disabled={inProgress(item)}
                        onClick={() => setSelected(item)}
                        aria-label={intl.formatMessage(messages.importRelease, {
                          release: item.releaseTitle,
                        })}
                      >
                        {item.state === 'importing' ? (
                          <ArrowPathIcon className="animate-spin" />
                        ) : (
                          <ArrowDownTrayIcon />
                        )}
                        <span>
                          {intl.formatMessage(
                            item.state === 'importing'
                              ? messages.importing
                              : messages.manualImport
                          )}
                        </span>
                      </Button>
                    )}
                    {inProgress(item) ? (
                      <Button buttonType="danger" className="min-h-11" disabled>
                        {item.state === 'importing' ? (
                          <span>{intl.formatMessage(messages.reject)}</span>
                        ) : (
                          <>
                            <ArrowPathIcon className="animate-spin" />
                            <span>
                              {intl.formatMessage(messages.rejecting)}
                            </span>
                          </>
                        )}
                      </Button>
                    ) : (
                      <Button
                        buttonType="ghost"
                        className="min-h-11 border-red-500/40 text-red-300 hover:border-red-400 hover:bg-red-500/10 focus:border-red-400"
                        onClick={() => setRejectItem(item)}
                        aria-label={intl.formatMessage(messages.rejectRelease, {
                          release: item.releaseTitle,
                        })}
                      >
                        {intl.formatMessage(messages.reject)}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </article>
          ))}
          {data.pageInfo.pages > 1 && (
            <div className="actions">
              <nav
                className="mb-3 flex flex-col items-center space-y-3 sm:flex-row sm:space-y-0"
                aria-label="Pagination"
              >
                <div className="flex sm:flex-1">
                  <p className="text-sm">
                    {Children.toArray(
                      intl.formatMessage(globalMessages.showingresults, {
                        from: page * TAKE + 1,
                        to: page * TAKE + data.results.length,
                        total: data.pageInfo.results,
                        strong: (msg: React.ReactNode) => (
                          <span className="font-medium">{msg}</span>
                        ),
                      })
                    )}
                  </p>
                </div>
                <div className="flex flex-auto justify-center space-x-2 sm:flex-1 sm:justify-end">
                  <Button
                    className="min-h-11"
                    disabled={page === 0}
                    onClick={() => updateView({ page: page - 1 })}
                  >
                    <ChevronLeftIcon />
                    <span>{intl.formatMessage(globalMessages.previous)}</span>
                  </Button>
                  <Button
                    className="min-h-11"
                    disabled={page + 1 >= data.pageInfo.pages}
                    onClick={() => updateView({ page: page + 1 })}
                  >
                    <span>{intl.formatMessage(globalMessages.next)}</span>
                    <ChevronRightIcon />
                  </Button>
                </div>
              </nav>
            </div>
          )}
        </div>
      )}
      <Dialog
        open={Boolean(rejectItem)}
        onClose={() => setRejectItem(undefined)}
        className="relative z-[100]"
      >
        <DialogBackdrop className="fixed inset-0 bg-gray-900/80 backdrop-blur-sm" />
        <div className="fixed inset-0 flex items-center justify-center overflow-y-auto p-4">
          <DialogPanel className="w-full max-w-lg space-y-4 rounded-xl bg-gray-800 p-5 shadow-xl ring-1 ring-gray-700">
            <DialogTitle className="text-xl font-semibold text-white">
              {intl.formatMessage(messages.rejectTitle)}
            </DialogTitle>
            <Description className="text-sm leading-6 text-gray-300">
              {intl.formatMessage(messages.rejectExplanation, {
                service: rejectItem?.serviceName ?? '',
              })}
            </Description>
            <p className="break-all rounded-lg bg-gray-900/70 p-3 font-mono text-xs text-gray-300">
              {rejectItem?.releaseTitle}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                data-autofocus
                className="min-h-11"
                onClick={() => setRejectItem(undefined)}
              >
                {intl.formatMessage(globalMessages.cancel)}
              </Button>
              <Button
                buttonType="danger"
                className="min-h-11"
                onClick={() => {
                  if (rejectItem) void reject(rejectItem);
                  setRejectItem(undefined);
                }}
              >
                {intl.formatMessage(messages.reject)}
              </Button>
            </div>
          </DialogPanel>
        </div>
      </Dialog>
      <SlideOver
        show={!!selected}
        title={intl.formatMessage(messages.manualImport)}
        subText={selected?.releaseTitle}
        onClose={() => setSelected(undefined)}
      >
        {selected && (
          <InterventionImport
            interventionId={selected.id}
            mediaId={selected.mediaId}
            is4k={selected.is4k}
            onChanged={() => {
              void (async () => {
                const next = await refresh();
                void mutate('/api/v1/servarr/interventions/count');
                if (
                  selected &&
                  next &&
                  !next.results.some((item) => item.id === selected.id)
                ) {
                  setSelected(undefined);
                }
              })();
            }}
          />
        )}
      </SlideOver>
    </>
  );
};

export default ServarrInterventions;
