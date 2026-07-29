import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import { CheckIcon, PlusIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { MediaRequestStatus } from '@server/constants/media';
import type { EpisodeSelection } from '@server/interfaces/api/requestInterfaces';
import { useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

interface EpisodeCatalogItem {
  tvdbId: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  airDate?: string;
}

interface EpisodeCatalog {
  tvdbSeriesId: number;
  episodes: EpisodeCatalogItem[];
}

const messages = defineMessages('components.RequestModal.EpisodeSelector', {
  title: 'Choose episodes',
  instruction: 'Select an episode to request.',
  loading: 'Loading the TVDB episode timeline…',
  unavailable: 'The TVDB episode catalog could not be loaded.',
  empty: 'No requestable episodes were found.',
  seasons: 'Seasons',
  specials: 'Specials',
  season: 'Season {seasonNumber}',
  episode: 'Episode {episodeNumber}',
  first: 'First',
  last: 'Last',
  selected: 'Selected',
  chooseFirst: 'Choose an episode',
  clear: 'Change selection',
  extend: 'Add more episodes',
  extendHint: 'Choose the last episode to include',
  extendFrom: 'Starting with {episodeCode}',
  cancelExtend: 'Cancel',
  singleSummary: '1 episode selected',
  rangeSummary:
    '{episodeCount} episodes selected across {seasonCount, plural, one {# season} other {# seasons}}',
  selectedInSeason: '{selectedCount} selected',
  specialsSingle: 'Specials can be requested one at a time.',
  episodeLabel: '{episodeCode}: {title}',
  ongoing: 'Include future episodes',
  ongoingSummary:
    '{episodeCount} available now across {seasonCount, plural, one {# season} other {# seasons}} · new episodes included',
  pendingApproval: 'Awaiting approval',
  requested: 'Requested',
  available: 'Available',
  failed: 'Failed',
  declined: 'Declined',
});

const episodeCode = (episode: EpisodeCatalogItem) =>
  `S${String(episode.seasonNumber).padStart(2, '0')}E${String(
    episode.episodeNumber
  ).padStart(2, '0')}`;

interface EpisodeSelectorProps {
  tmdbId: number;
  initialSelection?: EpisodeSelection;
  requestStates?: EpisodeSelectorRequestState[];
  onChange: (
    selection: EpisodeSelection | undefined,
    episodeCount: number,
    seasonCount: number
  ) => void;
}

export interface EpisodeSelectorRequestState {
  requestId: number;
  requestStatus: MediaRequestStatus;
  childStatus: MediaRequestStatus;
  seasonNumber: number;
  tvdbId?: number;
}

const effectiveRequestStatus = (state?: EpisodeSelectorRequestState) =>
  state?.requestStatus === MediaRequestStatus.FAILED ||
  state?.requestStatus === MediaRequestStatus.DECLINED ||
  state?.requestStatus === MediaRequestStatus.COMPLETED
    ? state.requestStatus
    : state?.childStatus;

const EpisodeSelector = ({
  tmdbId,
  initialSelection,
  requestStates = [],
  onChange,
}: EpisodeSelectorProps) => {
  const intl = useIntl();
  const settings = useSettings();
  const { data, error } = useSWR<EpisodeCatalog>(
    `/api/v1/tv/${tmdbId}/episodes`
  );
  const initialStartId =
    initialSelection?.type === 'single'
      ? initialSelection.episodeTvdbId
      : initialSelection?.startEpisodeTvdbId;
  const [startId, setStartId] = useState<number | undefined>(initialStartId);
  const [endId, setEndId] = useState<number | undefined>(
    initialSelection?.type === 'range'
      ? initialSelection.endEpisodeTvdbId
      : initialSelection?.type === 'single'
        ? initialSelection.episodeTvdbId
        : undefined
  );
  const [activeSeason, setActiveSeason] = useState<number | undefined>();
  const [isOngoing, setIsOngoing] = useState(
    initialSelection?.type === 'after'
  );
  const [isExtending, setIsExtending] = useState(false);

  const selectionEpisodes = useMemo(
    () =>
      (data?.episodes ?? []).filter(
        (episode) =>
          settings.currentSettings.enableSpecialEpisodes ||
          episode.seasonNumber > 0
      ),
    [data, settings.currentSettings.enableSpecialEpisodes]
  );
  const seasons = useMemo(
    () =>
      Array.from(
        new Set(selectionEpisodes.map((episode) => episode.seasonNumber))
      ),
    [selectionEpisodes]
  );
  const episodesInSeason = useMemo(
    () =>
      selectionEpisodes.filter(
        (episode) => episode.seasonNumber === activeSeason
      ),
    [activeSeason, selectionEpisodes]
  );
  const requestStateByEpisode = useMemo(() => {
    const states = [...requestStates].sort((a, b) => a.requestId - b.requestId);
    return new Map(
      selectionEpisodes.map((episode) => {
        const matchingStates = states.filter(
          (state) =>
            state.tvdbId === episode.tvdbId ||
            (state.tvdbId === undefined &&
              state.seasonNumber === episode.seasonNumber)
        );
        return [episode.tvdbId, matchingStates.at(-1)];
      })
    );
  }, [requestStates, selectionEpisodes]);
  const startIndex = selectionEpisodes.findIndex(
    (episode) => episode.tvdbId === startId
  );
  const endIndex = selectionEpisodes.findIndex(
    (episode) => episode.tvdbId === endId
  );
  const selectedStart = selectionEpisodes[startIndex];
  const selectedEnd = selectionEpisodes[endIndex];
  const hasSelection = startIndex >= 0 && endIndex >= startIndex;
  const isRange = !isOngoing && hasSelection && startIndex !== endIndex;
  const spansEpisodes = hasSelection && (isRange || isOngoing);
  const resolved = useMemo(
    () =>
      hasSelection ? selectionEpisodes.slice(startIndex, endIndex + 1) : [],
    [endIndex, hasSelection, selectionEpisodes, startIndex]
  );

  useEffect(() => {
    if (!selectionEpisodes.length) {
      return;
    }

    if (activeSeason === undefined) {
      const initialEpisode = selectionEpisodes.find(
        (episode) => episode.tvdbId === startId
      );
      setActiveSeason(
        initialEpisode?.seasonNumber ??
          selectionEpisodes.find((episode) => episode.seasonNumber > 0)
            ?.seasonNumber ??
          selectionEpisodes[0].seasonNumber
      );
    }

    if (initialSelection?.type === 'after' && startIndex >= 0 && endIndex < 0) {
      const lastRegularEpisode = selectionEpisodes.findLast(
        (episode) => episode.seasonNumber > 0
      );
      if (lastRegularEpisode) {
        setEndId(lastRegularEpisode.tvdbId);
      }
    }
  }, [
    activeSeason,
    endIndex,
    initialSelection?.type,
    initialStartId,
    selectionEpisodes,
    startId,
    startIndex,
  ]);

  useEffect(() => {
    if (!hasSelection || !selectedStart || !selectedEnd) {
      onChange(undefined, 0, 0);
      return;
    }

    const selection: EpisodeSelection = isOngoing
      ? { type: 'after', startEpisodeTvdbId: selectedStart.tvdbId }
      : isRange
        ? {
            type: 'range',
            startEpisodeTvdbId: selectedStart.tvdbId,
            endEpisodeTvdbId: selectedEnd.tvdbId,
          }
        : { type: 'single', episodeTvdbId: selectedStart.tvdbId };
    onChange(
      selection,
      resolved.length,
      new Set(resolved.map((episode) => episode.seasonNumber)).size
    );
  }, [
    hasSelection,
    isOngoing,
    isRange,
    onChange,
    resolved,
    selectedEnd,
    selectedStart,
  ]);

  const selectEpisode = (episode: EpisodeCatalogItem) => {
    const clickedIndex = selectionEpisodes.findIndex(
      (item) => item.tvdbId === episode.tvdbId
    );

    if (
      !isExtending ||
      !hasSelection ||
      episode.seasonNumber === 0 ||
      selectedStart.seasonNumber === 0
    ) {
      setStartId(episode.tvdbId);
      setEndId(episode.tvdbId);
      setIsOngoing(false);
      setIsExtending(false);
      return;
    }

    setIsOngoing(false);
    if (clickedIndex >= startIndex) {
      setEndId(episode.tvdbId);
    } else {
      setStartId(episode.tvdbId);
      setEndId(selectedStart.tvdbId);
    }
    setIsExtending(false);
  };

  const clearSelection = () => {
    setStartId(undefined);
    setEndId(undefined);
    setIsOngoing(false);
    setIsExtending(false);
  };

  const selectOngoing = () => {
    if (!selectedStart || selectedStart.seasonNumber === 0) {
      return;
    }
    const lastRegularEpisode = selectionEpisodes.findLast(
      (episode) => episode.seasonNumber > 0
    );
    if (!lastRegularEpisode) {
      return;
    }
    setEndId(lastRegularEpisode.tvdbId);
    setIsOngoing(true);
    setIsExtending(false);
  };

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-4 text-sm text-red-200">
        {intl.formatMessage(messages.unavailable)}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-900/60 p-8 text-center text-sm text-gray-300">
        {intl.formatMessage(messages.loading)}
      </div>
    );
  }
  if (!selectionEpisodes.length) {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-900/60 p-6 text-center text-sm text-gray-300">
        {intl.formatMessage(messages.empty)}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-lg border border-gray-700 bg-gray-900/40">
      <div className="border-b border-gray-700 px-4 py-4 sm:px-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="font-semibold text-white">
              {intl.formatMessage(messages.title)}
            </h3>
            <p className="mt-1 text-xs leading-5 text-gray-400">
              {intl.formatMessage(messages.instruction)}
            </p>
          </div>
          {hasSelection && !isExtending && (
            <button
              type="button"
              onClick={clearSelection}
              aria-label={intl.formatMessage(messages.clear)}
              className="-mr-1 shrink-0 rounded-md p-2 text-gray-400 transition hover:bg-gray-700 hover:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <XMarkIcon className="h-5 w-5" />
            </button>
          )}
        </div>

        {isExtending && selectedStart ? (
          <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-indigo-400/50 bg-indigo-500/10 px-3 py-3">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-white">
                {intl.formatMessage(messages.extendHint)}
              </p>
              <p className="mt-0.5 truncate text-xs text-indigo-200">
                {intl.formatMessage(messages.extendFrom, {
                  episodeCode: episodeCode(selectedStart),
                })}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setIsExtending(false)}
              className="shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium text-gray-300 hover:bg-gray-700 hover:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {intl.formatMessage(messages.cancelExtend)}
            </button>
          </div>
        ) : hasSelection && selectedStart ? (
          <div className="mt-4 rounded-lg border border-gray-700 bg-gray-800/70 p-3">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-indigo-500 text-white">
                <CheckIcon className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1" aria-live="polite">
                <p className="text-sm font-semibold text-white">
                  {intl.formatMessage(
                    isOngoing
                      ? messages.ongoingSummary
                      : isRange
                        ? messages.rangeSummary
                        : messages.singleSummary,
                    {
                      episodeCount: resolved.length,
                      seasonCount: new Set(
                        resolved.map((episode) => episode.seasonNumber)
                      ).size,
                    }
                  )}
                </p>
                <p className="mt-0.5 truncate text-xs text-gray-400">
                  {isRange && selectedEnd
                    ? `${episodeCode(selectedStart)} – ${episodeCode(
                        selectedEnd
                      )}`
                    : episodeCode(selectedStart)}
                </p>
              </div>
            </div>

            {!isRange && !isOngoing && selectedStart.seasonNumber > 0 && (
              <div className="mt-3 grid gap-2 border-t border-gray-700 pt-3 sm:grid-cols-2">
                <button
                  type="button"
                  data-testid="episode-selection-extend"
                  onClick={() => setIsExtending(true)}
                  className="flex items-center justify-center gap-2 rounded-md bg-gray-700 px-3 py-2 text-sm font-medium text-white transition hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <PlusIcon className="h-4 w-4" />
                  {intl.formatMessage(messages.extend)}
                </button>
                <button
                  type="button"
                  data-testid="episode-selection-ongoing"
                  onClick={selectOngoing}
                  className="rounded-md bg-gray-700 px-3 py-2 text-sm font-medium text-white transition hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  {intl.formatMessage(messages.ongoing)}
                </button>
              </div>
            )}
            {selectedStart.seasonNumber === 0 && (
              <p className="mt-2 text-xs text-gray-500">
                {intl.formatMessage(messages.specialsSingle)}
              </p>
            )}
          </div>
        ) : (
          <p className="mt-4 text-sm font-medium text-gray-300">
            {intl.formatMessage(messages.chooseFirst)}
          </p>
        )}
      </div>

      <div className="border-b border-gray-700 bg-gray-900/50 px-3 py-3 sm:px-4">
        <div className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-gray-500">
          {intl.formatMessage(messages.seasons)}
        </div>
        <div className="scrollbar-hide flex gap-1.5 overflow-x-auto pb-0.5">
          {seasons.map((seasonNumber) => {
            const selected = seasonNumber === activeSeason;
            const selectedCount = resolved.filter(
              (episode) => episode.seasonNumber === seasonNumber
            ).length;
            return (
              <button
                key={seasonNumber}
                type="button"
                data-testid={`episode-selection-season-${seasonNumber}`}
                aria-pressed={selected}
                onClick={() => setActiveSeason(seasonNumber)}
                className={`relative shrink-0 rounded-md px-3 py-2 text-sm font-medium transition focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
                  selected
                    ? 'bg-gray-700 text-white shadow-sm'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
                }`}
              >
                <span>
                  {seasonNumber === 0
                    ? intl.formatMessage(messages.specials)
                    : intl.formatMessage(messages.season, {
                        seasonNumber,
                      })}
                </span>
                {selectedCount > 0 && (
                  <span
                    className={`ml-2 inline-flex min-w-5 justify-center rounded-full px-1.5 text-[10px] leading-5 ${
                      selected
                        ? 'bg-indigo-500 text-white'
                        : 'bg-indigo-500/20 text-indigo-300'
                    }`}
                    aria-label={intl.formatMessage(messages.selectedInSeason, {
                      selectedCount,
                    })}
                  >
                    {selectedCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="max-h-[22rem] overflow-y-auto p-2 sm:p-3">
        <div
          className="space-y-1"
          role="group"
          aria-label={intl.formatMessage(messages.title)}
        >
          {episodesInSeason.map((episode) => {
            const index = selectionEpisodes.findIndex(
              (item) => item.tvdbId === episode.tvdbId
            );
            const isStart = episode.tvdbId === startId;
            const isEnd = isRange && episode.tvdbId === endId;
            const inRange =
              spansEpisodes && index >= startIndex && index <= endIndex;
            const selected = isStart || isEnd || inRange;
            const title =
              episode.title ||
              intl.formatMessage(messages.episode, {
                episodeNumber: episode.episodeNumber,
              });
            const selectionLabel = !spansEpisodes
              ? isStart
                ? messages.selected
                : undefined
              : isStart
                ? messages.first
                : isEnd
                  ? messages.last
                  : undefined;
            const requestStatus = effectiveRequestStatus(
              requestStateByEpisode.get(episode.tvdbId)
            );
            const requestStatusLabel =
              requestStatus === MediaRequestStatus.PENDING
                ? messages.pendingApproval
                : requestStatus === MediaRequestStatus.APPROVED
                  ? messages.requested
                  : requestStatus === MediaRequestStatus.COMPLETED
                    ? messages.available
                    : requestStatus === MediaRequestStatus.FAILED
                      ? messages.failed
                      : requestStatus === MediaRequestStatus.DECLINED
                        ? messages.declined
                        : undefined;
            const requestCovered =
              requestStatus !== undefined &&
              requestStatus !== MediaRequestStatus.DECLINED;

            return (
              <button
                key={episode.tvdbId}
                type="button"
                data-testid={`episode-selection-episode-${episode.tvdbId}`}
                onClick={() => selectEpisode(episode)}
                disabled={requestCovered}
                aria-pressed={selected}
                aria-label={intl.formatMessage(messages.episodeLabel, {
                  episodeCode: episodeCode(episode),
                  title,
                })}
                className={`group relative flex min-h-14 w-full items-center gap-3 overflow-hidden rounded-md border px-3 py-2.5 text-left transition focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1 focus:ring-offset-gray-900 ${
                  isStart || isEnd
                    ? 'border-indigo-400/70 bg-indigo-500/15 text-white'
                    : inRange
                      ? 'border-indigo-500/25 bg-indigo-500/[0.07] text-gray-100'
                      : requestCovered
                        ? 'cursor-not-allowed border-transparent bg-gray-900/30 text-gray-500'
                        : 'border-transparent text-gray-300 hover:border-gray-700 hover:bg-gray-800/80'
                }`}
              >
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-xs font-semibold tabular-nums transition ${
                    selected
                      ? 'bg-indigo-500 text-white'
                      : requestCovered
                        ? 'bg-gray-800/60 text-gray-600'
                        : 'bg-gray-800 text-gray-400 group-hover:bg-gray-700 group-hover:text-gray-200'
                  }`}
                >
                  E{episode.episodeNumber}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {title}
                  </span>
                  <span className="mt-0.5 flex items-center gap-2 text-[11px] text-gray-500">
                    <span className="font-mono">{episodeCode(episode)}</span>
                    {episode.airDate && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>
                          {intl.formatDate(episode.airDate, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                      </>
                    )}
                  </span>
                </span>
                {requestStatusLabel ? (
                  <span
                    data-testid={`episode-selection-request-status-${episode.tvdbId}`}
                    className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${
                      requestStatus === MediaRequestStatus.FAILED ||
                      requestStatus === MediaRequestStatus.DECLINED
                        ? 'bg-red-500/10 text-red-300'
                        : requestStatus === MediaRequestStatus.COMPLETED
                          ? 'bg-green-500/10 text-green-300'
                          : requestStatus === MediaRequestStatus.PENDING
                            ? 'bg-yellow-500/10 text-yellow-200'
                            : 'bg-indigo-400/10 text-indigo-200'
                    }`}
                  >
                    {intl.formatMessage(requestStatusLabel)}
                  </span>
                ) : selectionLabel ? (
                  <span className="shrink-0 rounded-full bg-indigo-400/15 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-indigo-200">
                    {intl.formatMessage(selectionLabel)}
                  </span>
                ) : inRange ? (
                  <CheckIcon className="h-4 w-4 shrink-0 text-indigo-300" />
                ) : null}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default EpisodeSelector;
