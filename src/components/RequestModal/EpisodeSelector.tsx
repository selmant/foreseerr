import Badge from '@app/components/Common/Badge';
import defineMessages from '@app/utils/defineMessages';
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
  individual: 'Single episode',
  range: 'Episode range',
  after: 'From episode onward',
  start: 'Starting episode',
  end: 'Ending episode',
  loading: 'Loading TVDB episode order…',
  unavailable: 'The TVDB episode catalog could not be loaded.',
  summary: '{episodeCount} episodes across {seasonCount} seasons',
  ongoing: 'Includes future episodes added to TVDB.',
});

const episodeLabel = (episode: EpisodeCatalogItem) =>
  `S${String(episode.seasonNumber).padStart(2, '0')}E${String(
    episode.episodeNumber
  ).padStart(2, '0')} — ${episode.title}`;

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

  useEffect(() => {
    if (data?.episodes.length && !startId) {
      setStartId(data.episodes[0].tvdbId);
    }
  }, [data, startId]);

  const resolved = useMemo(() => {
    if (!data || !startId) {
      return [];
    }
    const startIndex = data.episodes.findIndex(
      (episode) => episode.tvdbId === startId
    );
    if (startIndex < 0) {
      return [];
    }
    if (mode === 'single') {
      return [data.episodes[startIndex]];
    }
    if (mode === 'after') {
      return data.episodes.slice(startIndex).filter((e) => e.seasonNumber > 0);
    }
    const endIndex = data.episodes.findIndex(
      (episode) => episode.tvdbId === endId
    );
    return endIndex >= startIndex
      ? data.episodes
          .slice(startIndex, endIndex + 1)
          .filter((episode) => episode.seasonNumber > 0)
      : [];
  }, [data, endId, mode, startId]);

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

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/40 bg-red-950/30 p-4 text-sm text-red-200">
        {intl.formatMessage(messages.unavailable)}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="rounded-lg border border-gray-700 bg-gray-900/60 p-6 text-center text-sm text-gray-300">
        {intl.formatMessage(messages.loading)}
      </div>
    );
  }

  const modes: { id: EpisodeSelection['type']; label: string }[] = [
    { id: 'single', label: intl.formatMessage(messages.individual) },
    { id: 'range', label: intl.formatMessage(messages.range) },
    { id: 'after', label: intl.formatMessage(messages.after) },
  ];
  const startIndex = data.episodes.findIndex(
    (episode) => episode.tvdbId === startId
  );

  return (
    <div className="overflow-hidden rounded-lg border border-gray-700 bg-gray-900/60 shadow-inner">
      <div className="grid grid-cols-3 border-b border-gray-700 bg-gray-950/40 p-1">
        {modes.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              setMode(item.id);
              const selectedEpisode = data.episodes.find(
                (episode) => episode.tvdbId === startId
              );
              if (item.id !== 'single' && selectedEpisode?.seasonNumber === 0) {
                setStartId(
                  data.episodes.find((episode) => episode.seasonNumber > 0)
                    ?.tvdbId
                );
              }
              if (item.id === 'range' && !endId) {
                setEndId(startId);
              }
            }}
            className={`rounded-md px-2 py-2 text-xs font-semibold transition sm:text-sm ${
              mode === item.id
                ? 'bg-indigo-500 text-white shadow'
                : 'text-gray-300 hover:bg-gray-800 hover:text-white'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="grid gap-4 p-4 sm:grid-cols-2">
        <label className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          {intl.formatMessage(messages.start)}
          <select
            className="mt-2 w-full rounded-md border-gray-600 bg-gray-800 text-sm text-white focus:border-indigo-500 focus:ring-indigo-500"
            value={startId}
            onChange={(event) => {
              const value = Number(event.target.value);
              setStartId(value);
              if (mode === 'range') {
                setEndId(value);
              }
            }}
          >
            {data.episodes.map((episode) => (
              <option key={episode.tvdbId} value={episode.tvdbId}>
                {episodeLabel(episode)}
              </option>
            ))}
          </select>
        </label>
        {mode === 'range' && (
          <label className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            {intl.formatMessage(messages.end)}
            <select
              className="mt-2 w-full rounded-md border-gray-600 bg-gray-800 text-sm text-white focus:border-indigo-500 focus:ring-indigo-500"
              value={endId}
              onChange={(event) => setEndId(Number(event.target.value))}
            >
              {data.episodes.map((episode, index) => (
                <option
                  key={episode.tvdbId}
                  value={episode.tvdbId}
                  disabled={index < startIndex || episode.seasonNumber === 0}
                >
                  {episodeLabel(episode)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-gray-700 bg-gray-950/30 px-4 py-3 text-sm text-gray-300">
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
