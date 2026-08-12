import AirDateBadge from '@app/components/AirDateBadge';
import Badge from '@app/components/Common/Badge';
import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import RequestModal from '@app/components/RequestModal';
import { useMediaActionCapabilities } from '@app/hooks/useMediaActions';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { invalidateMediaActionCaches } from '@app/utils/mediaActionInvalidation';
import {
  writeSucceeded,
  type MediaActionWriteResponse,
} from '@app/utils/mediaActions';
import { quickRequestTvEpisodes } from '@app/utils/quickRequest';
import {
  ArrowDownTrayIcon,
  CheckCircleIcon as CheckCircleOutline,
  CheckIcon,
  ClockIcon,
  ExclamationCircleIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import { CheckCircleIcon as CheckCircleSolid } from '@heroicons/react/24/solid';
import { MediaRequestStatus } from '@server/constants/media';
import type { EpisodeSelection } from '@server/interfaces/api/requestInterfaces';
import type { SeasonWithEpisodes } from '@server/models/Tv';
import axios from 'axios';
import { useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.TvDetails.Season', {
  somethingwentwrong: 'Something went wrong while retrieving season data.',
  noepisodes: 'Episode list unavailable.',
  request: 'Request',
  requesting: 'Requesting…',
  requested: 'Requested',
  requestSuccess: '<strong>{episode}</strong> requested successfully!',
  requestError: 'Quick request failed. Opening request options.',
  pendingApproval: 'Awaiting approval',
  available: 'Available',
  failed: 'Failed',
  declined: 'Declined',
  markWatched: 'Mark watched',
  markUnwatched: 'Mark unwatched',
  watched: 'Watched',
  watchActionError: 'Could not update this episode. Try again.',
  watchActionPartial:
    'Updated on one provider, but another provider could not be synchronized.',
  seasonWatched: 'Watched',
  seasonWatchProgress: '{watched}/{total} watched',
});

export interface EpisodeRequestState {
  tvdbId: number;
  episodeStatus: MediaRequestStatus;
  requestStatus: MediaRequestStatus;
  requestId: number;
}

export type SeasonRequestState = Omit<EpisodeRequestState, 'tvdbId'>;

interface EpisodeWatchStatus {
  available: boolean;
  watchedEpisodeNumbers: number[];
}

const seasonWatchStatusKey = (tvId: number, seasonNumber: number) =>
  `/api/v1/media-actions/tv/${tvId}/seasons/${seasonNumber}/episodes/status`;

const effectiveRequestStatus = (state?: EpisodeRequestState) =>
  state?.requestStatus === MediaRequestStatus.FAILED ||
  state?.requestStatus === MediaRequestStatus.DECLINED ||
  state?.requestStatus === MediaRequestStatus.COMPLETED
    ? state.requestStatus
    : state?.episodeStatus;

export const SeasonWatchProgress = ({
  tvId,
  seasonNumber,
  episodeCount,
}: {
  tvId: number;
  seasonNumber: number;
  episodeCount: number;
}) => {
  const intl = useIntl();
  const { data: capabilities } = useMediaActionCapabilities();
  const enabled = Boolean(capabilities?.episode.watched);
  const { data } = useSWR<EpisodeWatchStatus>(
    enabled ? seasonWatchStatusKey(tvId, seasonNumber) : null,
    { revalidateOnFocus: false }
  );

  if (!data?.available) {
    return null;
  }
  const watched = Math.min(data.watchedEpisodeNumbers.length, episodeCount);
  return (
    <Badge badgeType={watched === episodeCount ? 'success' : 'dark'}>
      {intl.formatMessage(
        watched === episodeCount
          ? messages.seasonWatched
          : messages.seasonWatchProgress,
        { watched, total: episodeCount }
      )}
    </Badge>
  );
};

type SeasonProps = {
  seasonNumber: number;
  tvId: number;
  episodeRequestsEnabled?: boolean;
  episodeRequestStates?: EpisodeRequestState[];
  seasonRequestState?: SeasonRequestState;
  onRequestComplete?: () => void;
};

const Season = ({
  seasonNumber,
  tvId,
  episodeRequestsEnabled = false,
  episodeRequestStates = [],
  seasonRequestState,
  onRequestComplete,
}: SeasonProps) => {
  const intl = useIntl();
  const { data: capabilities } = useMediaActionCapabilities();
  const { addToast } = useToasts();
  const { hasPermission } = useUser();
  const { data, error, mutate } = useSWR<SeasonWithEpisodes>(
    `/api/v1/tv/${tvId}/season/${seasonNumber}`
  );
  const [requestingEpisodeId, setRequestingEpisodeId] = useState<
    number | undefined
  >();
  const [localRequestStates, setLocalRequestStates] = useState<
    EpisodeRequestState[]
  >([]);
  const [watchingEpisodeId, setWatchingEpisodeId] = useState<
    number | undefined
  >();
  const [fallbackSelection, setFallbackSelection] = useState<
    EpisodeSelection | undefined
  >();
  const requestStateByEpisode = useMemo(() => {
    const states = [...episodeRequestStates, ...localRequestStates].sort(
      (a, b) => a.requestId - b.requestId
    );
    const explicitStates = new Map(
      states.map((state) => [state.tvdbId, state])
    );

    if (!seasonRequestState || !data) {
      return explicitStates;
    }

    return new Map(
      data.episodes.map((episode) => {
        const explicitState = explicitStates.get(episode.id);
        return [
          episode.id,
          explicitState &&
          explicitState.requestId > seasonRequestState.requestId
            ? explicitState
            : { tvdbId: episode.id, ...seasonRequestState },
        ];
      })
    );
  }, [data, episodeRequestStates, localRequestStates, seasonRequestState]);
  const episodeActionsEnabled = Boolean(capabilities?.episode.watched);
  const watchStatusKey = episodeActionsEnabled
    ? seasonWatchStatusKey(tvId, seasonNumber)
    : null;
  const { data: watchStatus, mutate: mutateWatchStatus } =
    useSWR<EpisodeWatchStatus>(watchStatusKey, { revalidateOnFocus: false });
  const watchedEpisodeNumbers = useMemo(
    () => new Set(watchStatus?.watchedEpisodeNumbers ?? []),
    [watchStatus?.watchedEpisodeNumbers]
  );
  const canRequest =
    episodeRequestsEnabled &&
    hasPermission([Permission.REQUEST, Permission.REQUEST_TV], { type: 'or' });

  useEffect(() => {
    const serverIds = new Set(
      episodeRequestStates.map((state) => state.tvdbId)
    );
    setLocalRequestStates((states) =>
      states.filter((state) => !serverIds.has(state.tvdbId))
    );
  }, [episodeRequestStates]);

  const requestEpisode = async (episodeId: number, episodeLabel: string) => {
    const existingStatus = effectiveRequestStatus(
      requestStateByEpisode.get(episodeId)
    );
    if (
      requestingEpisodeId ||
      (existingStatus !== undefined &&
        existingStatus !== MediaRequestStatus.DECLINED)
    ) {
      return;
    }
    setRequestingEpisodeId(episodeId);
    try {
      const request = await quickRequestTvEpisodes({
        tmdbId: tvId,
        selection: { type: 'single', episodeTvdbId: episodeId },
      });
      const child = request.episodes?.find(
        (episode) => episode.tvdbId === episodeId
      );
      setLocalRequestStates((states) => [
        ...states.filter((state) => state.tvdbId !== episodeId),
        {
          tvdbId: episodeId,
          episodeStatus: child?.status ?? request.status,
          requestStatus: request.status,
          requestId: request.id,
        },
      ]);
      addToast(
        <span>
          {intl.formatMessage(messages.requestSuccess, {
            episode: episodeLabel,
            strong: (message: React.ReactNode) => <strong>{message}</strong>,
          })}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );
      await mutate();
      onRequestComplete?.();
    } catch {
      addToast(intl.formatMessage(messages.requestError), {
        appearance: 'warning',
        autoDismiss: true,
      });
      setFallbackSelection({ type: 'single', episodeTvdbId: episodeId });
    } finally {
      setRequestingEpisodeId(undefined);
    }
  };

  const toggleWatched = async (episodeId: number, episodeNumber: number) => {
    if (!watchStatus?.available || watchingEpisodeId) {
      return;
    }
    const wasWatched = watchedEpisodeNumbers.has(episodeNumber);
    const previous = watchStatus;
    const nextNumbers = wasWatched
      ? previous.watchedEpisodeNumbers.filter(
          (number) => number !== episodeNumber
        )
      : [...previous.watchedEpisodeNumbers, episodeNumber].sort(
          (a, b) => a - b
        );
    setWatchingEpisodeId(episodeId);
    await mutateWatchStatus(
      { ...previous, watchedEpisodeNumbers: nextNumbers },
      false
    );
    try {
      const action = wasWatched ? 'unwatched' : 'watched';
      const response = await axios.post<MediaActionWriteResponse>(
        `/api/v1/media-actions/tv/${tvId}/seasons/${seasonNumber}/episodes/${episodeNumber}/${action}`
      );
      if (!writeSucceeded(response.data)) {
        throw new Error('Episode watch update failed');
      }
      await invalidateMediaActionCaches({
        mediaType: 'tv',
        tmdbId: tvId,
        tvId,
        seasonNumber,
      });
      if (response.data.outcome === 'partial') {
        addToast(intl.formatMessage(messages.watchActionPartial), {
          appearance: 'warning',
          autoDismiss: true,
        });
      }
    } catch {
      await mutateWatchStatus(previous, false);
      addToast(intl.formatMessage(messages.watchActionError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setWatchingEpisodeId(undefined);
    }
  };

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <div>{intl.formatMessage(messages.somethingwentwrong)}</div>;
  }

  return (
    <>
      <RequestModal
        show={!!fallbackSelection}
        type="tv"
        tmdbId={tvId}
        initialRequestScope="episodes"
        initialEpisodeSelection={fallbackSelection}
        onCancel={() => setFallbackSelection(undefined)}
        onComplete={() => {
          if (fallbackSelection?.type === 'single') {
            setLocalRequestStates((states) => [
              ...states.filter(
                (state) => state.tvdbId !== fallbackSelection.episodeTvdbId
              ),
              {
                tvdbId: fallbackSelection.episodeTvdbId,
                episodeStatus: MediaRequestStatus.PENDING,
                requestStatus: MediaRequestStatus.PENDING,
                requestId: Number.MAX_SAFE_INTEGER,
              },
            ]);
          }
          setFallbackSelection(undefined);
          onRequestComplete?.();
        }}
      />
      <div className="flex flex-col justify-center divide-y divide-gray-700">
        {data.episodes.length === 0 ? (
          <p>{intl.formatMessage(messages.noepisodes)}</p>
        ) : (
          data.episodes
            .slice()
            .reverse()
            .map((episode) => {
              const episodeCode = `S${String(seasonNumber).padStart(
                2,
                '0'
              )}E${String(episode.episodeNumber).padStart(2, '0')}`;
              const requestState = requestStateByEpisode.get(episode.id);
              const requestStatus = effectiveRequestStatus(requestState);
              const isRequested =
                requestStatus !== undefined &&
                requestStatus !== MediaRequestStatus.DECLINED;
              const isRequesting = requestingEpisodeId === episode.id;
              const isWatched = watchedEpisodeNumbers.has(
                episode.episodeNumber
              );
              const isWatching = watchingEpisodeId === episode.id;
              const requestStatusPresentation =
                requestStatus === MediaRequestStatus.PENDING
                  ? {
                      label: messages.pendingApproval,
                      className:
                        'border-amber-400/30 bg-amber-400/10 text-amber-200',
                      Icon: ClockIcon,
                    }
                  : requestStatus === MediaRequestStatus.APPROVED
                    ? {
                        label: messages.requested,
                        className:
                          'border-indigo-400/30 bg-indigo-400/10 text-indigo-200',
                        Icon: ArrowDownTrayIcon,
                      }
                    : requestStatus === MediaRequestStatus.COMPLETED
                      ? {
                          label: messages.available,
                          className:
                            'border-emerald-400/30 bg-emerald-400/10 text-emerald-200',
                          Icon: CheckIcon,
                        }
                      : requestStatus === MediaRequestStatus.FAILED
                        ? {
                            label: messages.failed,
                            className:
                              'border-red-400/30 bg-red-400/10 text-red-200',
                            Icon: ExclamationCircleIcon,
                          }
                        : requestStatus === MediaRequestStatus.DECLINED
                          ? {
                              label: messages.declined,
                              className:
                                'border-gray-500/40 bg-gray-700/50 text-gray-300',
                              Icon: XCircleIcon,
                            }
                          : undefined;
              return (
                <div
                  className="group flex flex-col gap-4 py-4 xl:flex-row xl:items-center"
                  key={`season-${seasonNumber}-episode-${episode.episodeNumber}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-col space-y-2 xl:flex-row xl:items-center xl:space-x-2 xl:space-y-0">
                      <h3 className="text-lg">
                        {episode.episodeNumber} - {episode.name}
                      </h3>
                      {episode.airDate && (
                        <AirDateBadge airDate={episode.airDate} />
                      )}
                      {requestStatusPresentation && (
                        <span
                          data-testid={`episode-request-status-${episode.id}`}
                          className={`inline-flex w-fit items-center rounded-full border px-2 py-0.5 text-xs font-medium ${requestStatusPresentation.className}`}
                        >
                          <requestStatusPresentation.Icon className="mr-1 h-3.5 w-3.5" />
                          {intl.formatMessage(requestStatusPresentation.label)}
                        </span>
                      )}
                    </div>
                    {episode.overview && <p>{episode.overview}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {watchStatus?.available && (
                      <button
                        type="button"
                        disabled={isWatching}
                        onClick={() =>
                          void toggleWatched(episode.id, episode.episodeNumber)
                        }
                        className={`inline-flex h-9 items-center justify-center rounded-md border px-3 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2 focus:ring-offset-gray-900 disabled:cursor-wait disabled:opacity-60 ${
                          isWatched
                            ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/20'
                            : 'border-gray-600 bg-gray-800/70 text-gray-300 hover:border-gray-500 hover:text-white'
                        }`}
                        aria-pressed={isWatched}
                        aria-label={intl.formatMessage(
                          isWatched
                            ? messages.markUnwatched
                            : messages.markWatched
                        )}
                      >
                        {isWatched ? (
                          <CheckCircleSolid className="mr-1.5 h-4 w-4" />
                        ) : (
                          <CheckCircleOutline className="mr-1.5 h-4 w-4" />
                        )}
                        {intl.formatMessage(
                          isWatched ? messages.watched : messages.markWatched
                        )}
                      </button>
                    )}
                    {canRequest && !isRequested && (
                      <button
                        type="button"
                        data-testid={`episode-quick-request-${episode.id}`}
                        disabled={isRequesting}
                        onClick={() =>
                          void requestEpisode(
                            episode.id,
                            `${episodeCode} — ${episode.name}`
                          )
                        }
                        className="inline-flex h-9 shrink-0 items-center justify-center rounded-md border border-indigo-400/40 bg-indigo-500/10 px-3 text-sm font-semibold text-indigo-200 transition hover:border-indigo-400 hover:bg-indigo-500 hover:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-gray-900 disabled:cursor-wait disabled:opacity-60"
                        aria-label={`${intl.formatMessage(
                          messages.request
                        )} ${episodeCode}`}
                      >
                        <ArrowDownTrayIcon className="mr-1.5 h-4 w-4" />
                        {intl.formatMessage(
                          isRequesting ? messages.requesting : messages.request
                        )}
                      </button>
                    )}
                  </div>
                  {episode.stillPath && (
                    <div className="relative aspect-video xl:h-32">
                      <CachedImage
                        type="tmdb"
                        className="rounded-lg object-contain"
                        src={episode.stillPath}
                        alt=""
                        fill
                      />
                    </div>
                  )}
                </div>
              );
            })
        )}
      </div>
    </>
  );
};

export default Season;
