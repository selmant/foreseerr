import AirDateBadge from '@app/components/AirDateBadge';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import { handleLibraryPlayClick } from '@app/components/Library/libraryPlayAction';
import useLibraryItem from '@app/components/Library/useLibraryItem';
import RequestModal from '@app/components/RequestModal';
import { useNativeRuntime } from '@app/context/NativeRuntimeContext';
import { useMediaActionCapabilities } from '@app/hooks/useMediaActions';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { invalidateMediaActionCaches } from '@app/utils/mediaActionInvalidation';
import {
  failedProviderLabels,
  writeSucceeded,
  type MediaActionWriteResponse,
} from '@app/utils/mediaActions';
import {
  isTvQuotaExhausted,
  quickRequestTvEpisodes,
} from '@app/utils/quickRequest';
import {
  ArrowDownTrayIcon,
  CheckBadgeIcon as CheckBadgeOutline,
} from '@heroicons/react/24/outline';
import {
  CheckBadgeIcon as CheckBadgeSolid,
  PlayIcon,
} from '@heroicons/react/24/solid';
import { MediaRequestStatus } from '@server/constants/media';
import type {
  LibraryEpisode,
  LibrarySeasonEpisodesResponse,
} from '@server/interfaces/api/libraryInterfaces';
import type { EpisodeSelection } from '@server/interfaces/api/requestInterfaces';
import type { QuotaResponse } from '@server/interfaces/api/userInterfaces';
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
  quotaReached: 'Request quota reached. Opening request options.',
  pendingApproval: 'Awaiting Approval',
  available: 'Available',
  failed: 'Failed',
  play: 'Play',
  resume: 'Resume',
  declined: 'Declined',
  markWatched: 'Mark watched',
  markWatchedButton: 'Mark Watched',
  markUnwatched: 'Mark unwatched',
  watched: 'Watched',
  watchActionError: 'Could not update this episode. Try again.',
  watchActionPartial: 'Updated, but {providers} could not be synchronized.',
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
  /** Jellyfin series id; lets episodes already in the library offer Play. */
  jellyfinSeriesId?: string;
  onRequestComplete?: () => void;
};

/** Episodes Jellyfin already has for this season, keyed by episode number. */
const useLibrarySeasonEpisodes = (
  jellyfinSeriesId: string | undefined,
  seasonNumber: number
) => {
  const series = useLibraryItem(jellyfinSeriesId);
  const librarySeason = series?.seasons?.find(
    (season) => season.indexNumber === seasonNumber
  );
  const { data } = useSWR<LibrarySeasonEpisodesResponse>(
    jellyfinSeriesId && librarySeason
      ? `/api/v1/library/series/${jellyfinSeriesId}/seasons/${librarySeason.jellyfinSeasonId}/episodes`
      : null,
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  return useMemo(
    () =>
      new Map<number, LibraryEpisode>(
        (data?.episodes ?? []).flatMap((episode) =>
          episode.indexNumber != null && !data?.code
            ? [[episode.indexNumber, episode]]
            : []
        )
      ),
    [data]
  );
};

const Season = ({
  seasonNumber,
  tvId,
  episodeRequestsEnabled = false,
  episodeRequestStates = [],
  seasonRequestState,
  jellyfinSeriesId,
  onRequestComplete,
}: SeasonProps) => {
  const intl = useIntl();
  const { play } = useNativeRuntime();
  const libraryEpisodes = useLibrarySeasonEpisodes(
    jellyfinSeriesId,
    seasonNumber
  );
  const { data: capabilities } = useMediaActionCapabilities();
  const { addToast } = useToasts();
  const { user, hasPermission } = useUser();
  const { data, error, mutate } = useSWR<SeasonWithEpisodes>(
    `/api/v1/tv/${tvId}/season/${seasonNumber}`
  );
  const { data: quota } = useSWR<QuotaResponse>(
    user ? `/api/v1/user/${user.id}/quota` : null
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
    if (isTvQuotaExhausted(quota?.tv)) {
      addToast(intl.formatMessage(messages.quotaReached), {
        appearance: 'warning',
        autoDismiss: true,
      });
      setFallbackSelection({ type: 'single', episodeTvdbId: episodeId });
      setRequestingEpisodeId(undefined);
      return;
    }
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
        `/api/v1/media-actions/tv/${tvId}/seasons/${seasonNumber}/episodes/${episodeNumber}/${action}`,
        {}
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
        addToast(
          intl.formatMessage(messages.watchActionPartial, {
            providers:
              failedProviderLabels(response.data.providers) || 'a provider',
          }),
          {
            appearance: 'warning',
            autoDismiss: true,
          }
        );
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
              const libraryEpisode = libraryEpisodes.get(episode.episodeNumber);
              // Without a writable watch provider, Jellyfin still knows.
              const showLibraryWatched =
                !watchStatus?.available && Boolean(libraryEpisode?.watched);
              const resumePercent =
                !isWatched &&
                !libraryEpisode?.watched &&
                (libraryEpisode?.progressPercent ?? 0) > 0
                  ? Math.min(libraryEpisode?.progressPercent ?? 0, 100)
                  : 0;
              const requestStatusPresentation = libraryEpisode
                ? {
                    label: messages.available,
                    badgeType: 'success' as const,
                  }
                : requestStatus === MediaRequestStatus.PENDING
                  ? {
                      label: messages.pendingApproval,
                      badgeType: 'warning' as const,
                    }
                  : requestStatus === MediaRequestStatus.APPROVED
                    ? {
                        label: messages.requested,
                        badgeType: 'primary' as const,
                      }
                    : requestStatus === MediaRequestStatus.COMPLETED
                      ? {
                          label: messages.available,
                          badgeType: 'success' as const,
                        }
                      : requestStatus === MediaRequestStatus.FAILED
                        ? {
                            label: messages.failed,
                            badgeType: 'danger' as const,
                          }
                        : requestStatus === MediaRequestStatus.DECLINED
                          ? {
                              label: messages.declined,
                              badgeType: 'danger' as const,
                            }
                          : undefined;
              return (
                <div
                  className="group flex flex-col gap-4 py-4 xl:flex-row"
                  key={`season-${seasonNumber}-episode-${episode.episodeNumber}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <h3 className="text-lg">
                        {episode.episodeNumber} - {episode.name}
                      </h3>
                      {episode.airDate && (
                        <AirDateBadge airDate={episode.airDate} />
                      )}
                      {requestStatusPresentation && (
                        <span
                          data-testid={`episode-request-status-${episode.id}`}
                          className="inline-flex w-fit"
                        >
                          <Badge
                            badgeType={requestStatusPresentation.badgeType}
                          >
                            {intl.formatMessage(
                              requestStatusPresentation.label
                            )}
                          </Badge>
                        </span>
                      )}
                      {showLibraryWatched && (
                        <span className="inline-flex items-center gap-1 text-sm text-emerald-400">
                          <CheckBadgeSolid className="h-4 w-4" />
                          {intl.formatMessage(messages.watched)}
                        </span>
                      )}
                    </div>
                    {episode.overview && (
                      <p className="mt-1">{episode.overview}</p>
                    )}
                    {(libraryEpisode?.mediaUrl ||
                      watchStatus?.available ||
                      (canRequest && !isRequested && !libraryEpisode)) && (
                      <div className="mt-3 flex flex-wrap items-center gap-2">
                        {libraryEpisode?.mediaUrl && (
                          <Button
                            as="a"
                            href={libraryEpisode.mediaUrl}
                            buttonType="primary"
                            buttonSize="sm"
                            aria-label={`${intl.formatMessage(
                              messages.play
                            )} ${episodeCode}`}
                            onClick={(event) =>
                              handleLibraryPlayClick(event, play, {
                                provider: 'jellyfin',
                                itemId: libraryEpisode.jellyfinItemId,
                                fallbackUrl: libraryEpisode.mediaUrl as string,
                                label: `${episodeCode} ${episode.name}`,
                                quality: 'standard',
                              })
                            }
                          >
                            <PlayIcon />
                            <span>
                              {intl.formatMessage(
                                resumePercent > 0
                                  ? messages.resume
                                  : messages.play
                              )}
                            </span>
                          </Button>
                        )}
                        {watchStatus?.available && (
                          <Button
                            type="button"
                            buttonType="ghost"
                            buttonSize="sm"
                            disabled={isWatching}
                            onClick={() =>
                              void toggleWatched(
                                episode.id,
                                episode.episodeNumber
                              )
                            }
                            aria-pressed={isWatched}
                            aria-label={intl.formatMessage(
                              isWatched
                                ? messages.markUnwatched
                                : messages.markWatched
                            )}
                          >
                            {isWatched ? (
                              <CheckBadgeSolid className="text-emerald-400" />
                            ) : (
                              <CheckBadgeOutline />
                            )}
                            <span>
                              {intl.formatMessage(
                                isWatched
                                  ? messages.watched
                                  : messages.markWatchedButton
                              )}
                            </span>
                          </Button>
                        )}
                        {canRequest && !isRequested && !libraryEpisode && (
                          <Button
                            type="button"
                            buttonType="primary"
                            buttonSize="sm"
                            data-testid={`episode-quick-request-${episode.id}`}
                            disabled={isRequesting}
                            onClick={() =>
                              void requestEpisode(
                                episode.id,
                                `${episodeCode} — ${episode.name}`
                              )
                            }
                            aria-label={`${intl.formatMessage(
                              messages.request
                            )} ${episodeCode}`}
                          >
                            <ArrowDownTrayIcon />
                            <span>
                              {intl.formatMessage(
                                isRequesting
                                  ? messages.requesting
                                  : messages.request
                              )}
                            </span>
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                  {episode.stillPath && (
                    <div className="relative aspect-video overflow-hidden rounded-lg xl:h-32">
                      <CachedImage
                        type="tmdb"
                        className="rounded-lg object-contain"
                        src={episode.stillPath}
                        alt=""
                        fill
                      />
                      {resumePercent > 0 && (
                        <div className="absolute inset-x-0 bottom-0 h-1 bg-gray-900/70">
                          <div
                            className="h-full bg-indigo-500"
                            style={{ width: `${resumePercent}%` }}
                          />
                        </div>
                      )}
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
