import Button from '@app/components/Common/Button';
import useToasts from '@app/hooks/useToasts';
import axios from 'axios';
import { useEffect, useMemo, useRef, useState } from 'react';
import Select, { type StylesConfig } from 'react-select';

import {
  formatSize,
  type Episode,
  type Release,
  type ServarrContext,
} from './servarrTypes';

type SelectOption = {
  value: number;
  label: string;
  status?: Episode['queueStatus'] | 'downloaded' | 'wanted' | 'unmonitored';
};
type EpisodeStatus = NonNullable<SelectOption['status']>;

const episodeStatus = {
  downloading: {
    label: 'Downloading',
    className: 'border-sky-500/60 bg-sky-500/10 text-sky-200',
  },
  queued: {
    label: 'Queued',
    className: 'border-violet-500/60 bg-violet-500/10 text-violet-200',
  },
  importing: {
    label: 'Importing',
    className: 'border-emerald-500/60 bg-emerald-500/10 text-emerald-200',
  },
  'manual-import': {
    label: 'Import required',
    className: 'border-amber-500/60 bg-amber-500/10 text-amber-200',
  },
  downloaded: {
    label: 'Downloaded',
    className: 'border-gray-600 bg-gray-800 text-gray-300',
  },
  wanted: {
    label: 'Wanted',
    className: 'border-primary-500/60 bg-primary-500/10 text-primary-200',
  },
  unmonitored: {
    label: 'Not monitored',
    className: 'border-gray-700 bg-gray-900 text-gray-500',
  },
};

const episodeStatusOrder = {
  downloading: 0,
  importing: 1,
  'manual-import': 2,
  queued: 3,
  wanted: 4,
  unmonitored: 5,
  downloaded: 6,
};

const selectStyles: StylesConfig<SelectOption, false> = {
  menuPortal: (base) => ({ ...base, zIndex: 60 }),
  menu: (base) => ({ ...base, backgroundColor: '#374151', color: '#d1d5db' }),
  option: (base, state) => ({
    ...base,
    backgroundColor: state.isFocused ? '#4b5563' : '#374151',
    color: '#fff',
  }),
};

const errorMessage = (error: unknown, fallback: string) =>
  axios.isAxiosError(error)
    ? (error.response?.data?.message ?? fallback)
    : fallback;

const ReleaseSearch = ({
  mediaId,
  is4k,
  context,
  onChanged,
  onGrabbed,
}: {
  mediaId: number;
  is4k: boolean;
  context: ServarrContext;
  onChanged: () => void;
  onGrabbed: () => void;
}) => {
  const { addToast } = useToasts();
  const searchAbortRef = useRef<AbortController | undefined>(undefined);
  const grabAbortRef = useRef<AbortController | undefined>(undefined);
  const [target, setTarget] = useState<'episode' | 'season'>('episode');
  const [episodeId, setEpisodeId] = useState<number>();
  const [seasonNumber, setSeasonNumber] = useState<number>();
  const [releases, setReleases] = useState<Release[]>([]);
  const [searchError, setSearchError] = useState<string>();
  const [searching, setSearching] = useState(false);
  const [grabbingToken, setGrabbingToken] = useState<string>();
  const [grabFeedback, setGrabFeedback] = useState<{
    kind: 'success' | 'error';
    message: string;
  }>();
  const episodes = useMemo(
    () => context.seasons?.flatMap((season) => season.episodes) ?? [],
    [context.seasons]
  );
  const episodeOptions = useMemo<SelectOption[]>(
    () =>
      episodes
        .map((episode) => ({
          value: episode.id,
          label: `S${String(episode.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')} — ${episode.title}`,
          status: (episode.queueStatus ??
            (episode.hasFile
              ? 'downloaded'
              : episode.monitored
                ? 'wanted'
                : 'unmonitored')) as EpisodeStatus,
          seasonNumber: episode.seasonNumber,
          episodeNumber: episode.episodeNumber,
        }))
        .sort(
          (left, right) =>
            episodeStatusOrder[left.status] -
              episodeStatusOrder[right.status] ||
            left.seasonNumber - right.seasonNumber ||
            left.episodeNumber - right.episodeNumber
        )
        .map(({ value, label, status }) => ({ value, label, status })),
    [episodes]
  );
  const seasonOptions = useMemo<SelectOption[]>(
    () =>
      context.seasons?.map((season) => ({
        value: season.seasonNumber,
        label: `Season ${season.seasonNumber}`,
      })) ?? [],
    [context.seasons]
  );

  useEffect(() => {
    const preferredEpisode = episodes.find(
      (episode) => !episode.hasFile && episode.monitored
    );
    const firstSeason = context.seasons?.[0];
    setSeasonNumber(
      preferredEpisode?.seasonNumber ?? firstSeason?.seasonNumber
    );
    setEpisodeId(preferredEpisode?.id ?? firstSeason?.episodes[0]?.id);
  }, [context.seasons, episodes]);

  useEffect(() => {
    setReleases([]);
    setGrabFeedback(undefined);
  }, [target, episodeId, seasonNumber]);

  useEffect(
    () => () => {
      searchAbortRef.current?.abort();
      grabAbortRef.current?.abort();
    },
    []
  );

  const search = async () => {
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    setSearching(true);
    setSearchError(undefined);
    try {
      const params = new URLSearchParams({ is4k: String(is4k) });
      if (context.mediaType === 'tv') {
        params.set('target', target);
        if (target === 'episode' && episodeId)
          params.set('episodeId', String(episodeId));
        if (target === 'season' && seasonNumber !== undefined)
          params.set('seasonNumber', String(seasonNumber));
      }
      const response = await axios.get<{ results: Release[] }>(
        `/api/v1/media/${mediaId}/servarr/releases?${params}`,
        { signal: controller.signal }
      );
      if (!controller.signal.aborted) {
        setReleases(response.data.results);
        setGrabFeedback(undefined);
      }
    } catch (error) {
      if (!controller.signal.aborted)
        setSearchError(errorMessage(error, 'Release search failed.'));
    } finally {
      if (!controller.signal.aborted) setSearching(false);
    }
  };

  const grab = async (release: Release) => {
    grabAbortRef.current?.abort();
    const controller = new AbortController();
    grabAbortRef.current = controller;
    setGrabbingToken(release.token);
    setSearchError(undefined);
    setGrabFeedback(undefined);
    try {
      await axios.post(
        `/api/v1/media/${mediaId}/servarr/releases`,
        { is4k, token: release.token, acknowledgeRejections: release.rejected },
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      const message = `Sent to ${context.service.name ?? 'Arr'}. It may take a moment to appear in the download queue.`;
      setGrabFeedback({ kind: 'success', message });
      addToast('Release sent to download client.', {
        appearance: 'success',
        autoDismiss: true,
      });
      onGrabbed();
      onChanged();
    } catch (error) {
      if (controller.signal.aborted) return;
      const message = errorMessage(error, 'Unable to grab release.');
      setSearchError(message);
      setGrabFeedback({ kind: 'error', message });
      addToast(message, { appearance: 'error', autoDismiss: true });
    } finally {
      if (!controller.signal.aborted) setGrabbingToken(undefined);
    }
  };

  return (
    <div className="space-y-3">
      {context.mediaType === 'tv' && (
        <div className="space-y-2 rounded border border-gray-700 bg-gray-800/30 p-2">
          <div className="flex rounded-md border border-gray-600 bg-gray-900/40 p-0.5 text-sm">
            <button
              className={`flex-1 rounded px-3 py-1.5 transition ${target === 'episode' ? 'bg-primary-600 text-white shadow-sm' : 'text-gray-300 hover:bg-gray-700/70'}`}
              type="button"
              aria-pressed={target === 'episode'}
              onClick={() => setTarget('episode')}
            >
              Episode
            </button>
            <button
              className={`flex-1 rounded px-3 py-1.5 transition ${target === 'season' ? 'bg-primary-600 text-white shadow-sm' : 'text-gray-300 hover:bg-gray-700/70'}`}
              type="button"
              aria-pressed={target === 'season'}
              onClick={() => setTarget('season')}
            >
              Season pack
            </button>
          </div>
          {target === 'episode' ? (
            <Select<SelectOption, false>
              aria-label="Episode to search"
              className="react-select-container"
              classNamePrefix="react-select"
              isSearchable
              maxMenuHeight={250}
              menuPortalTarget={
                typeof document !== 'undefined' ? document.body : undefined
              }
              menuPosition="fixed"
              menuShouldScrollIntoView={false}
              options={episodeOptions}
              placeholder="Choose an episode"
              styles={selectStyles}
              formatOptionLabel={(option) => {
                const status = episodeStatus[option.status ?? 'wanted'];
                return (
                  <div className="flex min-w-0 items-center justify-between gap-3">
                    <span className="truncate">{option.label}</span>
                    <span
                      className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${status.className}`}
                    >
                      {status.label}
                    </span>
                  </div>
                );
              }}
              value={episodeOptions.find(
                (option) => option.value === episodeId
              )}
              onChange={(option) => setEpisodeId(option?.value)}
            />
          ) : (
            <Select<SelectOption, false>
              aria-label="Season pack to search"
              className="react-select-container"
              classNamePrefix="react-select"
              isSearchable={false}
              menuPortalTarget={
                typeof document !== 'undefined' ? document.body : undefined
              }
              menuPosition="fixed"
              menuShouldScrollIntoView={false}
              options={seasonOptions}
              placeholder="Choose a season"
              styles={selectStyles}
              value={seasonOptions.find(
                (option) => option.value === seasonNumber
              )}
              onChange={(option) => setSeasonNumber(option?.value)}
            />
          )}
        </div>
      )}
      <Button buttonType="primary" onClick={search} disabled={searching}>
        Search Releases
      </Button>
      {searchError && <div className="text-sm text-red-300">{searchError}</div>}
      {releases.length > 0 && (
        <div className="space-y-2">
          {grabFeedback && (
            <div
              aria-live="polite"
              className={`rounded border px-3 py-2 text-sm ${grabFeedback.kind === 'success' ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-100' : 'border-red-500/60 bg-red-500/10 text-red-100'}`}
              role="status"
            >
              {grabFeedback.message}
            </div>
          )}
          {releases.map((release) => (
            <div
              key={release.token}
              className={`rounded border p-2 text-sm ${release.rejected ? 'border-yellow-600 bg-yellow-950/20' : 'border-gray-700'}`}
            >
              <div className="break-all font-medium text-white">
                {release.title}
              </div>
              <div>
                {release.quality ?? 'Unknown quality'} ·{' '}
                {formatSize(release.size)} · {release.indexer} ·{' '}
                {release.protocol}
                {release.seeders !== undefined
                  ? ` · ${release.seeders} seeders`
                  : ''}
              </div>
              {release.rejections.length > 0 && (
                <div className="mt-1 text-yellow-300">
                  {release.rejections.join(' • ')}
                </div>
              )}
              <Button
                className="mt-2"
                buttonSize="sm"
                onClick={() => void grab(release)}
                disabled={
                  grabbingToken !== undefined ||
                  (!release.downloadAllowed && !release.rejected)
                }
              >
                {grabbingToken === release.token
                  ? `Sending to ${context.service.name}…`
                  : `Grab${release.rejected ? ' anyway' : ''}`}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ReleaseSearch;
