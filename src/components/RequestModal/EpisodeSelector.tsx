import Badge from '@app/components/Common/Badge';
import MultiRangeSlider from '@app/components/Common/MultiRangeSlider';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowsRightLeftIcon,
  CursorArrowRaysIcon,
  ForwardIcon,
} from '@heroicons/react/24/outline';
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
  individual: 'One episode',
  individualHint: 'Pick exactly one episode.',
  range: 'Episode range',
  rangeHint: 'Drag the handles or choose exact endpoints below.',
  after: 'From here onward',
  afterHint: 'Keep following this series as new episodes appear.',
  loading: 'Loading the TVDB episode timeline…',
  unavailable: 'The TVDB episode catalog could not be loaded.',
  empty: 'No requestable episodes were found.',
  seasons: 'Season navigator',
  specials: 'Specials',
  season: 'Season {seasonNumber}',
  episode: 'Episode {episodeNumber}',
  start: 'Start',
  end: 'End',
  selectingStart: 'Choosing start',
  selectingEnd: 'Choosing end',
  summary: '{episodeCount} episodes · {seasonCount} quota units',
  ongoing: 'Future TVDB episodes will join this request automatically.',
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
  const [mode, setMode] = useState<EpisodeSelection['type']>(
    initialSelection?.type ?? 'single'
  );
  const initialStart =
    initialSelection?.type === 'single'
      ? initialSelection.episodeTvdbId
      : initialSelection?.startEpisodeTvdbId;
  const [startId, setStartId] = useState<number | undefined>(initialStart);
  const [endId, setEndId] = useState<number | undefined>(
    initialSelection?.type === 'range'
      ? initialSelection.endEpisodeTvdbId
      : undefined
  );
  const [activeSeason, setActiveSeason] = useState<number | undefined>();
  const [rangeHandle, setRangeHandle] = useState<'start' | 'end'>('start');

  const requestableEpisodes = useMemo(
    () =>
      (data?.episodes ?? []).filter(
        (episode) =>
          settings.currentSettings.enableSpecialEpisodes ||
          episode.seasonNumber > 0
      ),
    [data, settings.currentSettings.enableSpecialEpisodes]
  );
  const regularEpisodes = useMemo(
    () => requestableEpisodes.filter((episode) => episode.seasonNumber > 0),
    [requestableEpisodes]
  );
  const selectionEpisodes =
    mode === 'single' ? requestableEpisodes : regularEpisodes;

  useEffect(() => {
    if (!selectionEpisodes.length) {
      return;
    }
    const selectedStart = selectionEpisodes.find(
      (episode) => episode.tvdbId === startId
    );
    const nextStart = selectedStart ?? selectionEpisodes[0];
    if (!selectedStart) {
      setStartId(nextStart.tvdbId);
    }
    if (activeSeason === undefined) {
      setActiveSeason(nextStart.seasonNumber);
    }
    if (mode === 'range') {
      const startIndex = selectionEpisodes.findIndex(
        (episode) => episode.tvdbId === nextStart.tvdbId
      );
      const selectedEndIndex = selectionEpisodes.findIndex(
        (episode) => episode.tvdbId === endId
      );
      if (selectedEndIndex < startIndex) {
        setEndId(nextStart.tvdbId);
      }
    }
  }, [activeSeason, endId, mode, selectionEpisodes, startId]);

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

  const resolved = useMemo(() => {
    if (startIndex < 0) {
      return [];
    }
    if (mode === 'single') {
      return [selectionEpisodes[startIndex]];
    }
    if (mode === 'after') {
      return selectionEpisodes.slice(startIndex);
    }
    return endIndex >= startIndex
      ? selectionEpisodes.slice(startIndex, endIndex + 1)
      : [];
  }, [endIndex, mode, selectionEpisodes, startIndex]);

  useEffect(() => {
    if (!startId || (mode === 'range' && !endId) || resolved.length === 0) {
      onChange(undefined, 0, 0);
      return;
    }
    const selection: EpisodeSelection =
      mode === 'single'
        ? { type: mode, episodeTvdbId: startId }
        : mode === 'range'
          ? {
              type: mode,
              startEpisodeTvdbId: startId,
              endEpisodeTvdbId: endId!,
            }
          : { type: mode, startEpisodeTvdbId: startId };
    onChange(
      selection,
      resolved.length,
      new Set(resolved.map((episode) => episode.seasonNumber)).size
    );
  }, [endId, mode, onChange, resolved, startId]);

  const selectMode = (nextMode: EpisodeSelection['type']) => {
    const nextEpisodes =
      nextMode === 'single' ? requestableEpisodes : regularEpisodes;
    const currentStart = nextEpisodes.find(
      (episode) => episode.tvdbId === startId
    );
    const nextStart = currentStart ?? nextEpisodes[0];
    setMode(nextMode);
    setRangeHandle(nextMode === 'range' ? 'end' : 'start');
    if (nextStart) {
      setStartId(nextStart.tvdbId);
      setActiveSeason(nextStart.seasonNumber);
      if (nextMode === 'range') {
        const currentEndIndex = nextEpisodes.findIndex(
          (episode) => episode.tvdbId === endId
        );
        const nextStartIndex = nextEpisodes.findIndex(
          (episode) => episode.tvdbId === nextStart.tvdbId
        );
        if (currentEndIndex < nextStartIndex) {
          setEndId(nextStart.tvdbId);
        }
      }
    }
  };

  const selectEpisode = (episode: EpisodeCatalogItem) => {
    if (mode !== 'range') {
      setStartId(episode.tvdbId);
      return;
    }
    const clickedIndex = selectionEpisodes.findIndex(
      (item) => item.tvdbId === episode.tvdbId
    );
    if (rangeHandle === 'start') {
      setStartId(episode.tvdbId);
      if (endIndex < clickedIndex) {
        setEndId(episode.tvdbId);
      }
      setRangeHandle('end');
    } else {
      if (clickedIndex < startIndex) {
        setStartId(episode.tvdbId);
      } else {
        setEndId(episode.tvdbId);
      }
      setRangeHandle('start');
    }
  };

  const updateRangeStart = useCallback(
    (index: number) => {
      const episode = selectionEpisodes[index];
      if (episode) {
        setStartId(episode.tvdbId);
        setActiveSeason(episode.seasonNumber);
      }
    },
    [selectionEpisodes]
  );
  const updateRangeEnd = useCallback(
    (index: number) => {
      const episode = selectionEpisodes[index];
      if (episode) {
        setEndId(episode.tvdbId);
      }
    },
    [selectionEpisodes]
  );
  const formatRangeValue = useCallback(
    (index: number) =>
      selectionEpisodes[index]
        ? episodeCode(selectionEpisodes[index])
        : String(index),
    [selectionEpisodes]
  );

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

  const modes = [
    {
      id: 'single' as const,
      label: intl.formatMessage(messages.individual),
      hint: intl.formatMessage(messages.individualHint),
      icon: CursorArrowRaysIcon,
    },
    {
      id: 'range' as const,
      label: intl.formatMessage(messages.range),
      hint: intl.formatMessage(messages.rangeHint),
      icon: ArrowsRightLeftIcon,
    },
    {
      id: 'after' as const,
      label: intl.formatMessage(messages.after),
      hint: intl.formatMessage(messages.afterHint),
      icon: ForwardIcon,
    },
  ];
  const selectedStart = selectionEpisodes[startIndex];
  const selectedEnd = selectionEpisodes[endIndex];

  return (
    <div className="overflow-hidden rounded-xl border border-gray-700 bg-gray-950/70 shadow-2xl shadow-black/20">
      <div className="grid gap-px border-b border-gray-700 bg-gray-700 sm:grid-cols-3">
        {modes.map((item) => {
          const Icon = item.icon;
          const selected = mode === item.id;
          return (
            <button
              key={item.id}
              type="button"
              data-testid={`episode-selection-mode-${item.id}`}
              onClick={() => selectMode(item.id)}
              className={`group flex items-start gap-3 bg-gray-900 px-4 py-3 text-left transition ${
                selected
                  ? 'bg-indigo-500/15 text-white shadow-[inset_0_-2px_0_#818cf8]'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-gray-100'
              }`}
            >
              <Icon
                className={`mt-0.5 h-5 w-5 shrink-0 ${
                  selected ? 'text-indigo-300' : 'text-gray-500'
                }`}
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold">
                  {item.label}
                </span>
                <span className="mt-0.5 hidden text-xs leading-4 text-gray-500 lg:block">
                  {item.hint}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {mode === 'range' && selectedStart && selectedEnd && (
        <div className="border-b border-gray-800 bg-gray-900/60 px-5 pb-4 pt-5">
          <div className="mb-4 flex items-center justify-between gap-3 text-xs font-semibold uppercase tracking-wider text-gray-500">
            <button
              type="button"
              onClick={() => {
                setRangeHandle('start');
                setActiveSeason(selectedStart.seasonNumber);
              }}
              className={`rounded-full border px-3 py-1.5 transition ${
                rangeHandle === 'start'
                  ? 'border-cyan-400/60 bg-cyan-400/10 text-cyan-200'
                  : 'border-gray-700 text-gray-400 hover:text-white'
              }`}
            >
              {intl.formatMessage(
                rangeHandle === 'start'
                  ? messages.selectingStart
                  : messages.start
              )}{' '}
              · {episodeCode(selectedStart)}
            </button>
            <span className="h-px flex-1 bg-gradient-to-r from-cyan-400/50 via-indigo-400/50 to-fuchsia-400/50" />
            <button
              type="button"
              onClick={() => {
                setRangeHandle('end');
                setActiveSeason(selectedEnd.seasonNumber);
              }}
              className={`rounded-full border px-3 py-1.5 transition ${
                rangeHandle === 'end'
                  ? 'border-fuchsia-400/60 bg-fuchsia-400/10 text-fuchsia-200'
                  : 'border-gray-700 text-gray-400 hover:text-white'
              }`}
            >
              {intl.formatMessage(
                rangeHandle === 'end' ? messages.selectingEnd : messages.end
              )}{' '}
              · {episodeCode(selectedEnd)}
            </button>
          </div>
          {selectionEpisodes.length > 1 && (
            <MultiRangeSlider
              min={0}
              max={selectionEpisodes.length - 1}
              defaultMinValue={Math.max(startIndex, 0)}
              defaultMaxValue={Math.max(endIndex, startIndex, 0)}
              formatValue={formatRangeValue}
              onUpdateMin={updateRangeStart}
              onUpdateMax={updateRangeEnd}
            />
          )}
        </div>
      )}

      <div className="border-b border-gray-800 bg-gray-900/30 px-4 py-3">
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
            const isEnd = mode === 'range' && episode.tvdbId === endId;
            const inRange =
              mode === 'range' && index >= startIndex && index <= endIndex;
            const selected = isStart || isEnd || inRange;
            return (
              <button
                key={episode.tvdbId}
                type="button"
                data-testid={`episode-selection-episode-${episode.tvdbId}`}
                onClick={() => selectEpisode(episode)}
                aria-pressed={selected}
                className={`relative min-h-20 overflow-hidden rounded-lg border p-3 text-left transition focus:outline-none focus:ring-2 focus:ring-indigo-400 ${
                  isStart && isEnd
                    ? 'border-indigo-300 bg-indigo-500/25 text-white'
                    : isStart
                      ? 'border-cyan-400/70 bg-cyan-400/10 text-white'
                      : isEnd
                        ? 'border-fuchsia-400/70 bg-fuchsia-400/10 text-white'
                        : inRange
                          ? 'border-indigo-500/40 bg-indigo-500/10 text-gray-100'
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
                        isStart ? messages.start : messages.end
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

      <div className="flex flex-wrap items-center gap-2 border-t border-gray-700 bg-gray-900/80 px-4 py-3 text-sm text-gray-300">
        {resolved.length > 0 && (
          <span className="font-mono text-xs font-semibold text-white">
            {episodeCode(resolved[0])}
            {mode === 'range' && resolved.length > 1
              ? ` → ${episodeCode(resolved[resolved.length - 1])}`
              : mode === 'after'
                ? ' → ∞'
                : ''}
          </span>
        )}
        <Badge badgeType={resolved.length ? 'primary' : 'danger'}>
          {intl.formatMessage(messages.summary, {
            episodeCount: resolved.length,
            seasonCount: new Set(
              resolved.map((episode) => episode.seasonNumber)
            ).size,
          })}
        </Badge>
        {mode === 'after' && (
          <span className="text-xs text-indigo-200">
            {intl.formatMessage(messages.ongoing)}
          </span>
        )}
      </div>
    </div>
  );
};

export default EpisodeSelector;
