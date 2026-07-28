import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import {
  CheckIcon,
  ChevronRightIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
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
  instruction:
    'Choose where the request starts. It can stop at one episode, end later, or stay open for new episodes.',
  loading: 'Loading the TVDB episode timeline…',
  unavailable: 'The TVDB episode catalog could not be loaded.',
  empty: 'No requestable episodes were found.',
  seasons: 'Seasons',
  specials: 'Specials',
  season: 'Season {seasonNumber}',
  episode: 'Episode {episodeNumber}',
  first: 'First episode',
  last: 'Through',
  selected: 'Selected',
  chooseFirst: 'Choose an episode',
  chooseLast: 'This episode only',
  editFirst: 'Change the first episode',
  editLast: 'Choose an ending',
  clear: 'Clear selection',
  removeLast: 'Request only {episodeCode}',
  singleSummary: '1 episode selected',
  rangeSummary:
    '{episodeCount} episodes selected across {seasonCount, plural, one {# season} other {# seasons}}',
  selectedInSeason: '{selectedCount} selected',
  specialsSingle: 'Specials can be requested one at a time.',
  episodeLabel: '{episodeCode}: {title}',
  ongoing: 'No end',
  chooseOngoing: 'Choose',
  ongoingDetail: 'New episodes included',
  ongoingOption: 'Keep this request open',
  ongoingDescription:
    'Include every episode from {episodeCode} and add new episodes automatically.',
  ongoingQuota: 'Episodes added later do not use more quota.',
  ongoingSummary:
    '{episodeCount} available now across {seasonCount, plural, one {# season} other {# seasons}} · new episodes included',
});

const episodeCode = (episode: EpisodeCatalogItem) =>
  `S${String(episode.seasonNumber).padStart(2, '0')}E${String(
    episode.episodeNumber
  ).padStart(2, '0')}`;

type ActiveBoundary = 'start' | 'end';

interface EpisodeSelectorProps {
  tmdbId: number;
  initialSelection?: EpisodeSelection;
  onChange: (
    selection: EpisodeSelection | undefined,
    episodeCount: number,
    seasonCount: number
  ) => void;
}

const EpisodeSelector = ({
  tmdbId,
  initialSelection,
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
  const [activeBoundary, setActiveBoundary] = useState<ActiveBoundary>('start');
  const [isOngoing, setIsOngoing] = useState(
    initialSelection?.type === 'after'
  );

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
      setActiveBoundary(initialStartId ? 'end' : 'start');
    }

    if (initialSelection?.type === 'after' && startIndex >= 0 && endIndex < 0) {
      const lastRegularEpisode = selectionEpisodes.findLast(
        (episode) => episode.seasonNumber > 0
      );
      if (lastRegularEpisode) {
        setEndId(lastRegularEpisode.tvdbId);
        setActiveBoundary('end');
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
      !hasSelection ||
      episode.seasonNumber === 0 ||
      selectedStart.seasonNumber === 0
    ) {
      setStartId(episode.tvdbId);
      setEndId(episode.tvdbId);
      setIsOngoing(false);
      setActiveBoundary(episode.seasonNumber === 0 ? 'start' : 'end');
      return;
    }

    if (activeBoundary === 'start') {
      if (isOngoing) {
        setStartId(episode.tvdbId);
        return;
      }
      if (clickedIndex <= endIndex) {
        setStartId(episode.tvdbId);
      } else {
        setStartId(selectedEnd.tvdbId);
        setEndId(episode.tvdbId);
        setActiveBoundary('end');
      }
      return;
    }

    setIsOngoing(false);
    if (clickedIndex >= startIndex) {
      setEndId(episode.tvdbId);
    } else {
      setStartId(episode.tvdbId);
      setEndId(selectedStart.tvdbId);
    }
  };

  const chooseBoundary = (boundary: ActiveBoundary) => {
    setActiveBoundary(boundary);
    const episode = boundary === 'start' ? selectedStart : selectedEnd;
    if (episode) {
      setActiveSeason(episode.seasonNumber);
    }
  };

  const clearSelection = () => {
    setStartId(undefined);
    setEndId(undefined);
    setIsOngoing(false);
    setActiveBoundary('start');
  };

  const collapseToSingle = () => {
    if (!selectedStart) {
      return;
    }
    setEndId(selectedStart.tvdbId);
    setIsOngoing(false);
    setActiveBoundary('end');
    setActiveSeason(selectedStart.seasonNumber);
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
    setActiveBoundary('end');
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
          {hasSelection && (
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

        <div className="mt-4 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-stretch gap-2 sm:gap-3">
          <button
            type="button"
            data-testid="episode-selection-boundary-start"
            aria-pressed={activeBoundary === 'start'}
            onClick={() => chooseBoundary('start')}
            className={`min-w-0 rounded-lg border px-3 py-2.5 text-left transition focus:outline-none focus:ring-2 focus:ring-indigo-500 ${
              activeBoundary === 'start'
                ? 'border-indigo-400 bg-indigo-500/15 shadow-sm shadow-indigo-950/50'
                : 'border-gray-700 bg-gray-800/70 hover:border-gray-500'
            }`}
          >
            <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-400">
              {intl.formatMessage(messages.first)}
            </span>
            <span className="mt-0.5 block truncate text-sm font-semibold text-white">
              {selectedStart
                ? episodeCode(selectedStart)
                : intl.formatMessage(messages.chooseFirst)}
            </span>
            <span className="mt-0.5 hidden truncate text-xs text-gray-400 sm:block">
              {selectedStart?.title || intl.formatMessage(messages.editFirst)}
            </span>
          </button>

          <div className="flex items-center text-gray-600" aria-hidden="true">
            <span className="hidden h-px w-3 bg-gray-600 sm:block" />
            <ChevronRightIcon className="h-4 w-4" />
            <span className="hidden h-px w-3 bg-gray-600 sm:block" />
          </div>

          <button
            type="button"
            data-testid="episode-selection-boundary-end"
            aria-pressed={activeBoundary === 'end'}
            disabled={!hasSelection || selectedStart?.seasonNumber === 0}
            onClick={() => chooseBoundary('end')}
            className={`group min-w-0 rounded-lg border px-3 py-2.5 text-left transition focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-45 ${
              activeBoundary === 'end' && selectedStart?.seasonNumber !== 0
                ? 'border-indigo-400 bg-indigo-500/15 shadow-sm shadow-indigo-950/50'
                : 'border-gray-700 bg-gray-800/70 hover:border-gray-500'
            }`}
          >
            <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] text-gray-400">
              {intl.formatMessage(messages.last)}
            </span>
            <span className="mt-0.5 block truncate text-sm font-semibold text-white">
              {isOngoing
                ? intl.formatMessage(messages.ongoing)
                : isRange && selectedEnd
                  ? episodeCode(selectedEnd)
                  : intl.formatMessage(messages.chooseLast)}
            </span>
            <span className="mt-0.5 hidden truncate text-xs text-gray-400 sm:block">
              {isOngoing
                ? intl.formatMessage(messages.ongoingDetail)
                : isRange && selectedEnd
                  ? selectedEnd.title
                  : intl.formatMessage(messages.editLast)}
            </span>
          </button>
        </div>

        <div
          className="mt-3 flex min-h-6 flex-wrap items-center gap-x-2 gap-y-1 text-xs"
          aria-live="polite"
        >
          <span className="font-medium text-gray-200">
            {hasSelection
              ? intl.formatMessage(
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
                )
              : intl.formatMessage(messages.chooseFirst)}
          </span>
          {(isRange || isOngoing) && selectedStart && (
            <button
              type="button"
              onClick={collapseToSingle}
              className="font-medium text-indigo-300 underline decoration-indigo-400/40 underline-offset-2 hover:text-indigo-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              {intl.formatMessage(messages.removeLast, {
                episodeCode: episodeCode(selectedStart),
              })}
            </button>
          )}
          {selectedStart?.seasonNumber === 0 && (
            <span className="text-gray-500">
              {intl.formatMessage(messages.specialsSingle)}
            </span>
          )}
        </div>
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
        {hasSelection && selectedStart.seasonNumber > 0 && (
          <button
            type="button"
            data-testid="episode-selection-ongoing"
            aria-pressed={isOngoing}
            onClick={selectOngoing}
            className={`mb-2 flex w-full items-center gap-3 rounded-lg border px-3 py-3 text-left transition focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1 focus:ring-offset-gray-900 ${
              isOngoing
                ? 'border-indigo-400 bg-indigo-500/15 text-white'
                : 'border-gray-700 bg-gray-800/60 text-gray-200 hover:border-gray-500 hover:bg-gray-800'
            }`}
          >
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-xl leading-none ${
                isOngoing
                  ? 'bg-indigo-500 text-white'
                  : 'bg-gray-700 text-indigo-300'
              }`}
              aria-hidden="true"
            >
              ∞
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">
                {intl.formatMessage(messages.ongoingOption)}
              </span>
              <span className="mt-0.5 block text-xs leading-5 text-gray-400">
                {intl.formatMessage(messages.ongoingDescription, {
                  episodeCode: episodeCode(selectedStart),
                })}{' '}
                {intl.formatMessage(messages.ongoingQuota)}
              </span>
            </span>
            <span
              className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${
                isOngoing
                  ? 'bg-indigo-400/20 text-indigo-100'
                  : 'bg-gray-700 text-gray-400'
              }`}
            >
              {intl.formatMessage(
                isOngoing ? messages.ongoing : messages.chooseOngoing
              )}
            </span>
          </button>
        )}
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

            return (
              <button
                key={episode.tvdbId}
                type="button"
                data-testid={`episode-selection-episode-${episode.tvdbId}`}
                onClick={() => selectEpisode(episode)}
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
                      : 'border-transparent text-gray-300 hover:border-gray-700 hover:bg-gray-800/80'
                }`}
              >
                <span
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-xs font-semibold tabular-nums transition ${
                    selected
                      ? 'bg-indigo-500 text-white'
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
                {selectionLabel ? (
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
