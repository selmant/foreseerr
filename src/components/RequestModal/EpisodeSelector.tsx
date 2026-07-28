import Badge from '@app/components/Common/Badge';
import MultiRangeSlider from '@app/components/Common/MultiRangeSlider';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import { ArrowsRightLeftIcon, XMarkIcon } from '@heroicons/react/24/outline';
import type { EpisodeSelection } from '@server/interfaces/api/requestInterfaces';
import { useCallback, useEffect, useMemo, useState } from 'react';
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
    'Select one episode, then optionally select another to include everything between them.',
  addEndpoint: 'Choose another episode to make a range',
  rangeReady: 'Range selected. Choose any episode to start over.',
  loading: 'Loading the TVDB episode timeline…',
  unavailable: 'The TVDB episode catalog could not be loaded.',
  empty: 'No requestable episodes were found.',
  seasons: 'Browse by season',
  specials: 'Specials',
  season: 'Season {seasonNumber}',
  episode: 'Episode {episodeNumber}',
  start: 'First',
  end: 'Last',
  single: 'Single episode',
  range: 'Episode range',
  clear: 'Clear selection',
  summary: '{episodeCount} episodes · {seasonCount} quota units',
});

const episodeCode = (episode: EpisodeCatalogItem) =>
  `S${String(episode.seasonNumber).padStart(2, '0')}E${String(
    episode.episodeNumber
  ).padStart(2, '0')}`;

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
  const [awaitingEndpoint, setAwaitingEndpoint] = useState(
    initialSelection?.type === 'single'
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
  const isRange = hasSelection && startIndex !== endIndex;
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
        setAwaitingEndpoint(false);
      }
    }
  }, [
    activeSeason,
    endIndex,
    initialSelection?.type,
    selectionEpisodes,
    startId,
    startIndex,
  ]);

  useEffect(() => {
    if (!hasSelection || !selectedStart || !selectedEnd) {
      onChange(undefined, 0, 0);
      return;
    }

    const selection: EpisodeSelection = isRange
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
  }, [hasSelection, isRange, onChange, resolved, selectedEnd, selectedStart]);

  const selectEpisode = (episode: EpisodeCatalogItem) => {
    const clickedIndex = selectionEpisodes.findIndex(
      (item) => item.tvdbId === episode.tvdbId
    );
    const startEpisode = selectionEpisodes[startIndex];
    const canExtendRange =
      awaitingEndpoint &&
      startIndex >= 0 &&
      startEpisode?.seasonNumber !== 0 &&
      episode.seasonNumber !== 0 &&
      clickedIndex !== startIndex;

    if (!canExtendRange) {
      setStartId(episode.tvdbId);
      setEndId(episode.tvdbId);
      setAwaitingEndpoint(episode.seasonNumber !== 0);
      return;
    }

    const firstIndex = Math.min(startIndex, clickedIndex);
    const lastIndex = Math.max(startIndex, clickedIndex);
    setStartId(selectionEpisodes[firstIndex].tvdbId);
    setEndId(selectionEpisodes[lastIndex].tvdbId);
    setAwaitingEndpoint(false);
  };

  const updateRangeStart = useCallback(
    (index: number) => {
      const episode = selectionEpisodes[index];
      if (episode?.seasonNumber !== 0) {
        setStartId(episode.tvdbId);
        setActiveSeason(episode.seasonNumber);
        setAwaitingEndpoint(index === endIndex);
      }
    },
    [endIndex, selectionEpisodes]
  );
  const updateRangeEnd = useCallback(
    (index: number) => {
      const episode = selectionEpisodes[index];
      if (episode?.seasonNumber !== 0) {
        setEndId(episode.tvdbId);
        setActiveSeason(episode.seasonNumber);
        setAwaitingEndpoint(index === startIndex);
      }
    },
    [selectionEpisodes, startIndex]
  );
  const formatRangeValue = useCallback(
    (index: number) =>
      selectionEpisodes[index]
        ? episodeCode(selectionEpisodes[index])
        : String(index),
    [selectionEpisodes]
  );
  const clearSelection = () => {
    setStartId(undefined);
    setEndId(undefined);
    setAwaitingEndpoint(false);
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
    <div className="overflow-hidden rounded-xl border border-gray-700 bg-gray-950/70 shadow-2xl shadow-black/20">
      <div className="border-b border-gray-700 bg-gray-900 px-4 py-4 sm:px-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="mt-0.5 rounded-lg border border-indigo-400/30 bg-indigo-500/10 p-2 text-indigo-200">
              <ArrowsRightLeftIcon className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">
                {intl.formatMessage(messages.title)}
              </h3>
              <p className="mt-1 max-w-xl text-xs leading-5 text-gray-400">
                {hasSelection
                  ? intl.formatMessage(
                      awaitingEndpoint
                        ? messages.addEndpoint
                        : messages.rangeReady
                    )
                  : intl.formatMessage(messages.instruction)}
              </p>
            </div>
          </div>
          {hasSelection && (
            <button
              type="button"
              onClick={clearSelection}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-gray-700 px-2.5 py-1.5 text-xs font-medium text-gray-400 transition hover:border-gray-500 hover:bg-gray-800 hover:text-white"
            >
              <XMarkIcon className="h-4 w-4" />
              <span className="hidden sm:inline">
                {intl.formatMessage(messages.clear)}
              </span>
            </button>
          )}
        </div>
      </div>

      {hasSelection && selectedStart && selectedEnd && (
        <div className="border-b border-gray-800 bg-gray-900/55 px-4 pb-5 pt-4 sm:px-5">
          <div className="mb-5 grid grid-cols-[1fr_auto_1fr] items-center gap-3">
            <button
              type="button"
              onClick={() => setActiveSeason(selectedStart.seasonNumber)}
              className="min-w-0 rounded-lg border border-cyan-400/30 bg-cyan-400/5 px-3 py-2 text-left transition hover:bg-cyan-400/10"
            >
              <span className="block text-[10px] font-bold uppercase tracking-[0.16em] text-cyan-300/80">
                {intl.formatMessage(isRange ? messages.start : messages.single)}
              </span>
              <span className="mt-0.5 block truncate font-mono text-sm font-bold text-white">
                {episodeCode(selectedStart)}
              </span>
            </button>
            <div className="flex items-center gap-1.5 text-gray-600">
              <span className="h-px w-3 bg-gray-700 sm:w-8" />
              <ArrowsRightLeftIcon className="h-4 w-4" />
              <span className="h-px w-3 bg-gray-700 sm:w-8" />
            </div>
            <button
              type="button"
              disabled={!isRange}
              onClick={() => setActiveSeason(selectedEnd.seasonNumber)}
              className={`min-w-0 rounded-lg border px-3 py-2 text-right transition ${
                isRange
                  ? 'border-indigo-400/30 bg-indigo-400/5 hover:bg-indigo-400/10'
                  : 'border-gray-800 bg-gray-900/40 opacity-40'
              }`}
            >
              <span className="block text-[10px] font-bold uppercase tracking-[0.16em] text-indigo-300/80">
                {intl.formatMessage(messages.end)}
              </span>
              <span className="mt-0.5 block truncate font-mono text-sm font-bold text-white">
                {isRange ? episodeCode(selectedEnd) : '—'}
              </span>
            </button>
          </div>
          {selectionEpisodes.length > 1 && selectedStart.seasonNumber !== 0 && (
            <MultiRangeSlider
              min={selectionEpisodes.findIndex(
                (episode) => episode.seasonNumber > 0
              )}
              max={selectionEpisodes.length - 1}
              defaultMinValue={startIndex}
              defaultMaxValue={endIndex}
              formatValue={formatRangeValue}
              onUpdateMin={updateRangeStart}
              onUpdateMax={updateRangeEnd}
            />
          )}
        </div>
      )}

      <div className="border-b border-gray-800 bg-gray-900/25 px-4 py-3">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-500">
          {intl.formatMessage(messages.seasons)}
        </div>
        <div className="scrollbar-hide flex gap-2 overflow-x-auto pb-1">
          {seasons.map((seasonNumber) => {
            const selected = seasonNumber === activeSeason;
            const count = selectionEpisodes.filter(
              (episode) => episode.seasonNumber === seasonNumber
            ).length;
            return (
              <button
                key={seasonNumber}
                type="button"
                data-testid={`episode-selection-season-${seasonNumber}`}
                onClick={() => setActiveSeason(seasonNumber)}
                className={`flex shrink-0 items-center gap-2 rounded-md border px-3 py-2 text-sm font-semibold transition ${
                  selected
                    ? 'border-indigo-400 bg-indigo-500 text-white shadow-lg shadow-indigo-950/40'
                    : 'border-gray-700 bg-gray-900 text-gray-300 hover:border-gray-500 hover:bg-gray-800'
                }`}
              >
                {seasonNumber === 0
                  ? intl.formatMessage(messages.specials)
                  : intl.formatMessage(messages.season, { seasonNumber })}
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                    selected ? 'bg-white/15' : 'bg-gray-800 text-gray-500'
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="max-h-[21rem] overflow-y-auto p-3 sm:p-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {episodesInSeason.map((episode) => {
            const index = selectionEpisodes.findIndex(
              (item) => item.tvdbId === episode.tvdbId
            );
            const isStart = episode.tvdbId === startId;
            const isEnd = isRange && episode.tvdbId === endId;
            const inRange = isRange && index >= startIndex && index <= endIndex;
            const selected = isStart || isEnd || inRange;
            return (
              <button
                key={episode.tvdbId}
                type="button"
                data-testid={`episode-selection-episode-${episode.tvdbId}`}
                onClick={() => selectEpisode(episode)}
                aria-pressed={selected}
                className={`relative min-h-20 overflow-hidden rounded-lg border p-3 text-left transition focus:outline-none focus:ring-2 focus:ring-indigo-400 ${
                  isStart && !isRange
                    ? 'border-cyan-300 bg-cyan-400/15 text-white shadow-[inset_3px_0_0_#67e8f9]'
                    : isStart
                      ? 'border-cyan-400/70 bg-cyan-400/10 text-white'
                      : isEnd
                        ? 'border-indigo-400/70 bg-indigo-400/10 text-white'
                        : inRange
                          ? 'border-indigo-500/35 bg-indigo-500/10 text-gray-100'
                          : 'border-gray-700 bg-gray-900/80 text-gray-300 hover:border-gray-500 hover:bg-gray-800'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs font-bold tracking-wide text-indigo-200">
                    {episodeCode(episode)}
                  </span>
                  {(isStart || isEnd) && (
                    <span className="rounded bg-white/10 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-white">
                      {intl.formatMessage(
                        !isRange
                          ? messages.single
                          : isStart
                            ? messages.start
                            : messages.end
                      )}
                    </span>
                  )}
                </div>
                <div className="mt-1.5 line-clamp-2 text-sm font-medium leading-5">
                  {episode.title ||
                    intl.formatMessage(messages.episode, {
                      episodeNumber: episode.episodeNumber,
                    })}
                </div>
                {episode.airDate && (
                  <div className="mt-2 text-[11px] text-gray-500">
                    {intl.formatDate(episode.airDate, {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex min-h-12 flex-wrap items-center gap-2 border-t border-gray-700 bg-gray-900/80 px-4 py-3 text-sm text-gray-300">
        {hasSelection ? (
          <>
            <Badge badgeType="primary">
              {intl.formatMessage(isRange ? messages.range : messages.single)}
            </Badge>
            <span className="font-mono text-xs font-semibold text-white">
              {episodeCode(selectedStart)}
              {isRange ? ` → ${episodeCode(selectedEnd)}` : ''}
            </span>
            <span className="text-xs text-gray-500">·</span>
            <span className="text-xs text-gray-400">
              {intl.formatMessage(messages.summary, {
                episodeCount: resolved.length,
                seasonCount: new Set(
                  resolved.map((episode) => episode.seasonNumber)
                ).size,
              })}
            </span>
          </>
        ) : (
          <span className="text-xs text-gray-500">
            {intl.formatMessage(messages.instruction)}
          </span>
        )}
      </div>
    </div>
  );
};

export default EpisodeSelector;
