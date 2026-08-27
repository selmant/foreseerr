import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import SlideOver from '@app/components/Common/SlideOver';
import InterventionImport from '@app/components/ServarrInterventions/InterventionImport';
import type {
  InterventionResults,
  ServarrIntervention,
} from '@app/components/ServarrInterventions/types';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowPathIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FunnelIcon,
} from '@heroicons/react/24/solid';
import axios from 'axios';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';

const TAKE = 25;

const messages = defineMessages('components.ServarrInterventions', {
  title: 'Interventions',
  description: 'Review mapped Sonarr and Radarr queue warnings.',
  active: 'Active',
  history: 'Blocklisted by Foreseerr',
  allServices: 'All services',
  allTypes: 'All types',
  emptyActive: 'No active warnings.',
  emptyHistory: 'No Foreseerr blocklist history.',
  loadError: 'Unable to load interventions.',
  firstSeen: 'First seen {date}',
  overdue: 'Overdue',
  remaining: '{hours}h {minutes}m remaining',
  cleanupError: 'Last cleanup error: {error}',
  automaticCleanup: 'Automatic cleanup',
  manualRejection: 'Manual rejection{actor}',
  byActor: ' by {name}',
  manualImport: 'Manual import',
  reject: 'Reject and blocklist',
  rejecting: 'Rejecting…',
  importing: 'Importing…',
  inProgress: 'In progress',
  rejectConfirm: 'Delete this download and blocklist the release in {service}?',
  rejected: 'Release rejected and blocklisted.',
  rejectFailed: 'Rejection failed.',
});

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
  const [mode, setMode] = useState<'active' | 'history'>('active');
  const [page, setPage] = useState(0);
  const [serviceType, setServiceType] = useState('');
  const [mediaType, setMediaType] = useState('');
  const [selected, setSelected] = useState<ServarrIntervention>();
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
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
    void axios
      .post('/api/v1/servarr/interventions/seen')
      .then(() => mutate('/api/v1/servarr/interventions/count'));
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
        <div className="mt-2 flex flex-grow flex-col sm:flex-row lg:flex-grow-0">
          <div className="mb-2 flex flex-grow sm:mb-0 sm:mr-2 lg:flex-grow-0">
            <Button
              buttonType={mode === 'active' ? 'primary' : 'default'}
              onClick={() => {
                setMode('active');
                setPage(0);
              }}
            >
              {intl.formatMessage(messages.active)}
              {data && mode === 'active' ? ` (${data.pageInfo.results})` : ''}
            </Button>
          </div>
          <div className="mb-2 flex flex-grow sm:mb-0 lg:flex-grow-0">
            <Button
              buttonType={mode === 'history' ? 'primary' : 'default'}
              onClick={() => {
                setMode('history');
                setPage(0);
              }}
            >
              {intl.formatMessage(messages.history)}
            </Button>
          </div>
        </div>
      </div>
      <div className="mb-4 flex flex-col sm:flex-row sm:space-x-2">
        <div className="mb-2 flex flex-grow sm:mb-0 lg:flex-grow-0">
          <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-sm text-gray-100">
            <FunnelIcon className="h-6 w-6" />
          </span>
          <select
            value={serviceType}
            onChange={(event) => {
              setServiceType(event.target.value);
              setPage(0);
            }}
            className="rounded-r-only"
          >
            <option value="">{intl.formatMessage(messages.allServices)}</option>
            <option value="radarr">Radarr</option>
            <option value="sonarr">Sonarr</option>
          </select>
        </div>
        <div className="mb-2 flex flex-grow sm:mb-0 lg:flex-grow-0">
          <select
            value={mediaType}
            onChange={(event) => {
              setMediaType(event.target.value);
              setPage(0);
            }}
            className="rounded-md"
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
      </div>
      {!data && !error && <LoadingSpinner />}
      {error && (
        <div className="rounded bg-red-900/40 p-4 text-red-200">
          {intl.formatMessage(messages.loadError)}
        </div>
      )}
      {data && (
        <div className="space-y-3">
          {data.results.length === 0 && (
            <div className="rounded-md bg-gray-800 p-8 text-center text-gray-300">
              {intl.formatMessage(
                mode === 'active' ? messages.emptyActive : messages.emptyHistory
              )}
            </div>
          )}
          {data.results.map((item) => (
            <article
              key={item.id}
              className="rounded-md border border-gray-700 bg-gray-800/80 p-4"
            >
              <div className="flex flex-wrap justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="truncate text-lg font-semibold text-white">
                      {item.releaseTitle}
                    </h2>
                    {inProgress(item) && (
                      <Badge badgeType="primary">
                        {intl.formatMessage(messages.inProgress)}
                      </Badge>
                    )}
                  </div>
                  <div className="text-sm text-gray-300">
                    <Link
                      href={
                        item.mediaType === 'movie'
                          ? `/movie/${item.tmdbId}`
                          : `/tv/${item.tmdbId}`
                      }
                      className="hover:underline"
                    >
                      {item.mediaType === 'movie'
                        ? intl.formatMessage(globalMessages.movie)
                        : intl.formatMessage(globalMessages.tvshow)}
                    </Link>
                    {' · '}
                    {item.serviceName}
                    {item.is4k ? ' · 4K' : ''}
                  </div>
                  {item.warningMessages.length > 0 && (
                    <ul className="mt-2 list-inside list-disc text-sm text-yellow-200">
                      {item.warningMessages.map((message, index) => (
                        <li key={`${item.id}-${index}`}>{message}</li>
                      ))}
                    </ul>
                  )}
                  {item.cleanupError && (
                    <div className="mt-2 text-sm text-red-300">
                      {intl.formatMessage(messages.cleanupError, {
                        error: item.cleanupError,
                      })}
                    </div>
                  )}
                  <div className="mt-2 text-xs text-gray-400">
                    {mode === 'active' ? (
                      <>
                        {intl.formatMessage(messages.firstSeen, {
                          date: new Date(item.firstSeenAt).toLocaleString(),
                        })}{' '}
                        · <Countdown deadline={item.cleanupDeadlineAt} />
                      </>
                    ) : (
                      <>
                        {item.resolvedAt
                          ? new Date(item.resolvedAt).toLocaleString()
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
                {mode === 'active' && (
                  <div className="flex items-start gap-2">
                    {item.manualImportCapable && (
                      <Button
                        disabled={inProgress(item)}
                        onClick={() => setSelected(item)}
                      >
                        {item.state === 'importing' ? (
                          <>
                            <ArrowPathIcon className="mr-2 h-4 w-4 animate-spin" />
                            {intl.formatMessage(messages.importing)}
                          </>
                        ) : (
                          intl.formatMessage(messages.manualImport)
                        )}
                      </Button>
                    )}
                    {inProgress(item) ? (
                      <Button buttonType="danger" disabled>
                        {item.state === 'importing' ? (
                          intl.formatMessage(messages.reject)
                        ) : (
                          <>
                            <ArrowPathIcon className="mr-2 h-4 w-4 animate-spin" />
                            {intl.formatMessage(messages.rejecting)}
                          </>
                        )}
                      </Button>
                    ) : (
                      <ConfirmButton
                        confirmText={intl.formatMessage(
                          messages.rejectConfirm,
                          { service: item.serviceName }
                        )}
                        onClick={() => void reject(item)}
                      >
                        {intl.formatMessage(messages.reject)}
                      </ConfirmButton>
                    )}
                  </div>
                )}
              </div>
            </article>
          ))}
          {data.pageInfo.pages > 1 && (
            <div className="flex items-center justify-center gap-3 pt-3">
              <Button
                disabled={page === 0}
                onClick={() => setPage((value) => value - 1)}
              >
                <ChevronLeftIcon />
                <span>{intl.formatMessage(globalMessages.previous)}</span>
              </Button>
              <span className="text-sm text-gray-300">
                {page + 1} / {data.pageInfo.pages}
              </span>
              <Button
                disabled={page + 1 >= data.pageInfo.pages}
                onClick={() => setPage((value) => value + 1)}
              >
                <span>{intl.formatMessage(globalMessages.next)}</span>
                <ChevronRightIcon />
              </Button>
            </div>
          )}
        </div>
      )}
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
