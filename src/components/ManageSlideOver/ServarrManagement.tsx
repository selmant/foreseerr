import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import useToasts from '@app/hooks/useToasts';
import axios from 'axios';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Select, { type StylesConfig } from 'react-select';

type Episode = {
  id: number;
  seasonNumber: number;
  episodeNumber: number;
  title: string;
  hasFile: boolean;
  monitored: boolean;
  queueStatus?: 'downloading' | 'queued' | 'importing' | 'manual-import';
};
type Context = {
  mediaType: 'movie' | 'tv';
  service: { type: string; name: string };
  seasons?: { seasonNumber: number; episodes: Episode[] }[];
  nativeUrl?: string;
};
type ImportSource = {
  token: string;
  kind: 'queue';
  label: string;
};
type Rejection = { reason: string; type?: string };
type SelectOption = {
  value: number;
  label: string;
  status?:
    | 'downloading'
    | 'queued'
    | 'importing'
    | 'manual-import'
    | 'downloaded'
    | 'wanted'
    | 'unmonitored';
};
type Release = {
  token: string;
  title: string;
  quality?: string;
  size: number;
  ageHours: number;
  indexer: string;
  protocol: string;
  seeders?: number;
  rejections: string[];
  rejected: boolean;
  downloadAllowed: boolean;
};
type Candidate = {
  token: string;
  source?: string;
  name: string;
  relativePath?: string;
  folderName?: string;
  size: number;
  quality?: string;
  languages: string[];
  releaseGroup?: string;
  customFormats: string[];
  customFormatScore?: number;
  rejections: Rejection[];
  seasonNumber?: number;
  episodes?: Episode[];
  complete: boolean;
};
type GrabFeedback = { kind: 'success' | 'error'; message: string };

const MANUAL_IMPORT_POLL_MS = 2000;
const MANUAL_IMPORT_POLL_DEADLINE_MS = 5 * 60 * 1000;

const formatSize = (size: number) =>
  `${(size / 1024 / 1024 / 1024).toFixed(2)} GB`;

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

const slideOverSelectStyles: StylesConfig<SelectOption, false> = {
  menuPortal: (base) => ({ ...base, zIndex: 60 }),
  menu: (base) => ({
    ...base,
    backgroundColor: '#374151',
    color: '#d1d5db',
  }),
  option: (base, state) => ({
    ...base,
    backgroundColor: state.isFocused ? '#4b5563' : '#374151',
    color: '#fff',
  }),
};

const ServarrPanel = ({
  mediaId,
  is4k,
  label,
  onChanged,
}: {
  mediaId: number;
  is4k: boolean;
  label: string;
  onChanged: () => void;
}) => {
  const { addToast } = useToasts();
  const [context, setContext] = useState<Context>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [grabbingToken, setGrabbingToken] = useState<string>();
  const [grabFeedback, setGrabFeedback] = useState<GrabFeedback>();
  const [releases, setReleases] = useState<Release[]>([]);
  const [target, setTarget] = useState<'episode' | 'season'>('episode');
  const [episodeId, setEpisodeId] = useState<number>();
  const [seasonNumber, setSeasonNumber] = useState<number>();
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [sources, setSources] = useState<ImportSource[]>([]);
  const [importWorkflowOpen, setImportWorkflowOpen] = useState(false);
  const [importAvailabilityError, setImportAvailabilityError] = useState<
    string | undefined
  >();
  const [selectedSource, setSelectedSource] = useState<string>();
  const [importSourceLabel, setImportSourceLabel] = useState<string>();
  const [selected, setSelected] = useState<string[]>([]);
  const [episodeMappings, setEpisodeMappings] = useState<
    Record<string, number[]>
  >({});
  const [mode, setMode] = useState<'move' | 'copy'>('move');
  const [importStatus, setImportStatus] = useState<string>();
  const importPollRef = useRef<{
    timeoutId?: number;
    cancelled: boolean;
  }>({ cancelled: false });
  const episodes = useMemo(
    () => context?.seasons?.flatMap((season) => season.episodes) ?? [],
    [context]
  );
  const episodeOptions = useMemo<SelectOption[]>(
    () =>
      episodes
        .map((episode) => ({
          value: episode.id,
          label: `S${String(episode.seasonNumber).padStart(2, '0')}E${String(
            episode.episodeNumber
          ).padStart(2, '0')} — ${episode.title}`,
          status:
            episode.queueStatus ??
            (episode.hasFile
              ? ('downloaded' as const)
              : episode.monitored
                ? ('wanted' as const)
                : ('unmonitored' as const)),
          seasonNumber: episode.seasonNumber,
          episodeNumber: episode.episodeNumber,
        }))
        .sort(
          (left, right) =>
            episodeStatusOrder[left.status ?? 'wanted'] -
              episodeStatusOrder[right.status ?? 'wanted'] ||
            left.seasonNumber - right.seasonNumber ||
            left.episodeNumber - right.episodeNumber
        )
        .map(({ value, label, status }) => ({ value, label, status })),
    [episodes]
  );
  const seasonOptions = useMemo<SelectOption[]>(
    () =>
      context?.seasons?.map((season) => ({
        value: season.seasonNumber,
        label: `Season ${season.seasonNumber}`,
      })) ?? [],
    [context]
  );

  const refreshImportSources = useCallback(async () => {
    try {
      const response = await axios.get<{
        sources: ImportSource[];
      }>(`/api/v1/media/${mediaId}/servarr/imports/sources?is4k=${is4k}`);
      setSources(response.data.sources);
      setSelectedSource((current) =>
        response.data.sources.some((source) => source.token === current)
          ? current
          : response.data.sources[0]?.token
      );
      setImportAvailabilityError(undefined);
    } catch (err) {
      setSources([]);
      setImportAvailabilityError(
        axios.isAxiosError(err)
          ? (err.response?.data?.message ??
              'Unable to check whether a download needs manual import.')
          : 'Unable to check whether a download needs manual import.'
      );
    }
  }, [is4k, mediaId]);

  useEffect(() => {
    setLoading(true);
    axios
      .get<Context>(`/api/v1/media/${mediaId}/servarr/context?is4k=${is4k}`)
      .then((response) => {
        setContext(response.data);
        const preferredEpisode = response.data.seasons
          ?.flatMap((season) => season.episodes)
          .find((episode) => !episode.hasFile && episode.monitored);
        if (preferredEpisode) {
          setSeasonNumber(preferredEpisode.seasonNumber);
          setEpisodeId(preferredEpisode.id);
        } else if (response.data.seasons?.[0]) {
          setSeasonNumber(response.data.seasons[0].seasonNumber);
          setEpisodeId(response.data.seasons[0].episodes[0]?.id);
        }
      })
      .catch((err) =>
        setError(
          err.response?.data?.message ??
            'Unable to connect to the mapped Servarr service.'
        )
      )
      .finally(() => setLoading(false));
    void refreshImportSources();
  }, [is4k, mediaId, refreshImportSources]);

  useEffect(() => {
    setReleases([]);
    setGrabFeedback(undefined);
  }, [target, episodeId, seasonNumber]);

  useEffect(() => {
    const poll = importPollRef.current;
    poll.cancelled = false;
    return () => {
      poll.cancelled = true;
      if (poll.timeoutId != null) {
        window.clearTimeout(poll.timeoutId);
      }
    };
  }, []);

  const search = async () => {
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams({ is4k: String(is4k) });
      if (context?.mediaType === 'tv') {
        params.set('target', target);
        if (target === 'episode' && episodeId)
          params.set('episodeId', String(episodeId));
        if (target === 'season' && seasonNumber !== undefined)
          params.set('seasonNumber', String(seasonNumber));
      }
      const response = await axios.get<{ results: Release[] }>(
        `/api/v1/media/${mediaId}/servarr/releases?${params}`
      );
      setReleases(response.data.results);
      setGrabFeedback(undefined);
    } catch (err) {
      setError(
        axios.isAxiosError(err)
          ? (err.response?.data?.message ?? 'Release search failed.')
          : 'Release search failed.'
      );
    } finally {
      setLoading(false);
    }
  };
  const grab = async (release: Release) => {
    setGrabbingToken(release.token);
    setError(undefined);
    setGrabFeedback(undefined);
    try {
      await axios.post(`/api/v1/media/${mediaId}/servarr/releases`, {
        is4k,
        token: release.token,
        acknowledgeRejections: release.rejected,
      });
      const message = `Sent to ${context?.service.name ?? 'Arr'}. It may take a moment to appear in the download queue.`;
      setGrabFeedback({ kind: 'success', message });
      addToast('Release sent to download client.', {
        appearance: 'success',
        autoDismiss: true,
      });
      void refreshImportSources();
      onChanged();
    } catch (err) {
      const message = axios.isAxiosError(err)
        ? (err.response?.data?.message ?? 'Unable to grab release.')
        : 'Unable to grab release.';
      setError(message);
      setGrabFeedback({ kind: 'error', message });
      addToast(message, {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setGrabbingToken(undefined);
    }
  };
  const loadImportSources = () => {
    setError(undefined);
    setCandidates([]);
    setSelected([]);
    setImportSourceLabel(undefined);
    setImportWorkflowOpen(true);
  };
  const scanImportSource = async () => {
    if (!selectedSource) return;
    setLoading(true);
    setError(undefined);
    try {
      const response = await axios.post<{
        source: string;
        candidates: Candidate[];
      }>(`/api/v1/media/${mediaId}/servarr/imports/scan`, {
        is4k,
        sourceToken: selectedSource,
      });
      setImportSourceLabel(response.data.source);
      setCandidates(response.data.candidates);
      setSelected([]);
      setEpisodeMappings({});
    } catch (err) {
      const message = axios.isAxiosError(err)
        ? (err.response?.data?.message ?? 'Unable to scan this import source.')
        : 'Unable to scan this import source.';
      setError(message);
      if (axios.isAxiosError(err) && err.response?.status === 409) {
        setImportWorkflowOpen(false);
        void refreshImportSources();
      }
    } finally {
      setLoading(false);
    }
  };
  const reprocessCandidate = async (candidate: Candidate) => {
    const episodeIds =
      episodeMappings[candidate.token] ??
      candidate.episodes?.map((episode) => episode.id) ??
      [];
    if (!episodeIds.length) {
      setError('Choose at least one episode before rematching.');
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const response = await axios.post<Candidate>(
        `/api/v1/media/${mediaId}/servarr/imports/reprocess`,
        { is4k, candidateToken: candidate.token, episodeIds }
      );
      setCandidates((current) =>
        current.map((item) =>
          item.token === candidate.token ? response.data : item
        )
      );
      setSelected((current) =>
        current.map((token) =>
          token === candidate.token ? response.data.token : token
        )
      );
      setEpisodeMappings((current) => {
        const next = { ...current };
        delete next[candidate.token];
        return { ...next, [response.data.token]: episodeIds };
      });
    } catch (err) {
      setError(
        axios.isAxiosError(err)
          ? err.response?.data?.message
          : 'Sonarr could not rematch this file.'
      );
    } finally {
      setLoading(false);
    }
  };
  const submitImport = async () => {
    const files = candidates.filter((candidate) =>
      selected.includes(candidate.token)
    );
    const warnings = files.flatMap((candidate) =>
      candidate.rejections.map((rejection) => rejection.reason)
    );
    if (
      !window.confirm(
        `Import ${files.length} file(s) using ${mode}?${warnings.length ? `\n\nWarnings:\n${warnings.join('\n')}` : ''}`
      )
    )
      return;
    try {
      const response = await axios.post(
        `/api/v1/media/${mediaId}/servarr/imports`,
        {
          is4k,
          candidateTokens: selected,
          importMode: mode,
          acknowledgeRejections: warnings.length > 0,
          episodeMappings: Object.entries(episodeMappings)
            .filter(([token]) => selected.includes(token))
            .map(([candidateToken, episodeIds]) => ({
              candidateToken,
              episodeIds,
            })),
        }
      );
      addToast(`Manual import queued (${response.data.status ?? 'queued'}).`, {
        appearance: 'success',
        autoDismiss: true,
      });
      setSelected([]);
      setImportStatus(response.data.status ?? 'queued');
      setCandidates([]);
      setImportWorkflowOpen(false);
      void refreshImportSources();
      onChanged();
      const startedAt = Date.now();
      const poll = async () => {
        const pollState = importPollRef.current;
        if (pollState.cancelled) {
          return;
        }
        if (Date.now() - startedAt > MANUAL_IMPORT_POLL_DEADLINE_MS) {
          setError('Manual import status check timed out.');
          return;
        }
        try {
          const status = await axios.get<{ status: string; message?: string }>(
            `/api/v1/media/${mediaId}/servarr/commands/${response.data.commandToken}?is4k=${is4k}`
          );
          if (pollState.cancelled) {
            return;
          }
          setImportStatus(status.data.status);
          if (['completed', 'failed', 'aborted'].includes(status.data.status)) {
            if (status.data.status === 'completed') {
              addToast('Manual import completed.', {
                appearance: 'success',
                autoDismiss: true,
              });
              void refreshImportSources();
              onChanged();
            } else setError(status.data.message ?? 'Manual import failed.');
            return;
          }
          pollState.timeoutId = window.setTimeout(() => {
            void poll();
          }, MANUAL_IMPORT_POLL_MS);
        } catch {
          if (!pollState.cancelled) {
            setError('Unable to read manual import status.');
          }
        }
      };
      importPollRef.current.timeoutId = window.setTimeout(() => {
        void poll();
      }, MANUAL_IMPORT_POLL_MS);
    } catch (err) {
      setError(
        axios.isAxiosError(err)
          ? err.response?.data?.message
          : 'Unable to submit manual import.'
      );
    }
  };
  if (loading && !context) return <LoadingSpinner />;
  if (!context) return <div className="text-sm text-red-300">{error}</div>;
  return (
    <div className="space-y-3 rounded-md border border-gray-700 p-3">
      <div className="font-semibold text-white">
        {label} ({context.service.name})
      </div>
      {error && <div className="text-sm text-red-300">{error}</div>}
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
              styles={slideOverSelectStyles}
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
              styles={slideOverSelectStyles}
              value={seasonOptions.find(
                (option) => option.value === seasonNumber
              )}
              onChange={(option) => setSeasonNumber(option?.value)}
            />
          )}
        </div>
      )}
      <div className="flex gap-2">
        <Button buttonType="primary" onClick={search} disabled={loading}>
          Search Releases
        </Button>
        {sources.length > 0 && (
          <Button
            buttonType="default"
            className="border-yellow-700 text-yellow-200 hover:bg-yellow-950/40"
            onClick={loadImportSources}
            disabled={loading}
          >
            Manual Import ({sources.length})
          </Button>
        )}
        {context.nativeUrl && (
          <a
            className="text-primary-400 hover:text-primary-300 self-center text-sm"
            href={context.nativeUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open in {context.service.type === 'sonarr' ? 'Sonarr' : 'Radarr'}
          </a>
        )}
      </div>
      {importAvailabilityError && (
        <div className="flex items-center gap-2 text-xs text-yellow-300">
          <span>{importAvailabilityError}</span>
          <button
            className="underline hover:text-yellow-100"
            type="button"
            onClick={() => void refreshImportSources()}
          >
            Retry
          </button>
        </div>
      )}
      {releases.length > 0 && (
        <div className="space-y-2">
          {grabFeedback && (
            <div
              aria-live="polite"
              className={`rounded border px-3 py-2 text-sm ${
                grabFeedback.kind === 'success'
                  ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-100'
                  : 'border-red-500/60 bg-red-500/10 text-red-100'
              }`}
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
                onClick={() => grab(release)}
                disabled={
                  grabbingToken !== undefined ||
                  (!release.downloadAllowed && !release.rejected)
                }
              >
                {grabbingToken === release.token
                  ? 'Sending to Sonarr…'
                  : `Grab${release.rejected ? ' anyway' : ''}`}
              </Button>
            </div>
          ))}
        </div>
      )}
      {importStatus && (
        <div className="text-sm text-gray-300">
          Manual import: {importStatus}
        </div>
      )}
      {importWorkflowOpen && sources.length > 0 && !candidates.length && (
        <div className="space-y-2 rounded border border-gray-700 bg-gray-800/30 p-3 text-sm">
          <div className="font-medium text-white">
            Choose an Arr import source
          </div>
          <p className="text-gray-300">
            Foreseerr asks {context.service.name} to scan the selected download;
            it does not inspect your filesystem itself.
          </p>
          <select
            className="w-full"
            value={selectedSource}
            onChange={(event) => setSelectedSource(event.target.value)}
          >
            {sources.map((source) => (
              <option key={source.token} value={source.token}>
                Download: {source.label}
              </option>
            ))}
          </select>
          <Button
            buttonType="primary"
            buttonSize="sm"
            disabled={!selectedSource || loading}
            onClick={scanImportSource}
          >
            Review files
          </Button>
        </div>
      )}
      {importSourceLabel && !loading && candidates.length === 0 && (
        <div className="rounded border border-gray-700 p-3 text-sm text-gray-300">
          {context.service.name} found no manual-import candidates in{' '}
          {importSourceLabel}.
        </div>
      )}
      {candidates.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm text-gray-300">
            <span>Review from {importSourceLabel}</span>
            <Button
              buttonType="default"
              buttonSize="sm"
              onClick={() => {
                setCandidates([]);
                setImportSourceLabel(undefined);
                setImportWorkflowOpen(true);
              }}
            >
              Change source
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={mode}
              onChange={(event) =>
                setMode(event.target.value as 'move' | 'copy')
              }
            >
              <option value="move">Move files</option>
              <option value="copy">Copy files</option>
            </select>
            <Button
              buttonType="success"
              buttonSize="sm"
              disabled={!selected.length}
              onClick={submitImport}
            >
              Import selected ({selected.length})
            </Button>
          </div>
          {candidates.map((candidate) => (
            <div
              key={candidate.token}
              className="block rounded border border-gray-700 p-2 text-sm"
            >
              <label>
                <input
                  className="mr-2"
                  type="checkbox"
                  disabled={!candidate.complete}
                  checked={selected.includes(candidate.token)}
                  onChange={() =>
                    setSelected((current) =>
                      current.includes(candidate.token)
                        ? current.filter((token) => token !== candidate.token)
                        : [...current, candidate.token]
                    )
                  }
                />
                <span className="font-medium text-white">{candidate.name}</span>
                <span className="ml-2">
                  {formatSize(candidate.size)} ·{' '}
                  {candidate.quality ?? 'Unknown quality'}
                  {candidate.source ? ` · ${candidate.source}` : ''}
                </span>
              </label>
              <div className="ml-6 mt-1 text-gray-300">
                {candidate.languages.join(', ') || 'Unknown language'}
                {candidate.customFormats.length
                  ? ` · ${candidate.customFormats.join(', ')}`
                  : ''}
                {candidate.customFormatScore !== undefined
                  ? ` · CF ${candidate.customFormatScore}`
                  : ''}
              </div>
              {!candidate.complete && (
                <div className="ml-6 mt-1 text-yellow-300">
                  Arr needs additional metadata for this file. Open it in Arr to
                  complete the import.
                </div>
              )}
              {context.mediaType === 'tv' &&
                (selected.includes(candidate.token) || !candidate.complete) && (
                  <div className="ml-6 mt-2 rounded border border-gray-600 p-2">
                    <div className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-400">
                      Sonarr episode assignment
                    </div>
                    <div className="max-h-40 space-y-1 overflow-y-auto">
                      {episodes.map((episode) => {
                        const assigned =
                          episodeMappings[candidate.token] ??
                          candidate.episodes?.map((item) => item.id) ??
                          [];
                        return (
                          <label key={episode.id} className="block">
                            <input
                              className="mr-2"
                              type="checkbox"
                              checked={assigned.includes(episode.id)}
                              onChange={() =>
                                setEpisodeMappings((current) => {
                                  const ids =
                                    current[candidate.token] ?? assigned;
                                  return {
                                    ...current,
                                    [candidate.token]: ids.includes(episode.id)
                                      ? ids.filter((id) => id !== episode.id)
                                      : [...ids, episode.id],
                                  };
                                })
                              }
                            />
                            S{String(episode.seasonNumber).padStart(2, '0')}E
                            {String(episode.episodeNumber).padStart(2, '0')} —{' '}
                            {episode.title}
                          </label>
                        );
                      })}
                    </div>
                    <Button
                      className="mt-2"
                      buttonType="default"
                      buttonSize="sm"
                      disabled={loading}
                      onClick={() => reprocessCandidate(candidate)}
                    >
                      Apply with Sonarr
                    </Button>
                  </div>
                )}
              {candidate.rejections.length > 0 && (
                <div className="ml-6 mt-1 text-yellow-300">
                  {candidate.rejections
                    .map((rejection) => rejection.reason)
                    .join(' • ')}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const ServarrManagement = ({
  mediaId,
  hasStandardMapping,
  has4kMapping,
  mediaType,
  onChanged,
}: {
  mediaId: number;
  hasStandardMapping: boolean;
  has4kMapping: boolean;
  mediaType: 'movie' | 'tv';
  onChanged: () => void;
}) => (
  <div className="space-y-3">
    <h3 className="text-xl font-bold">
      {mediaType === 'movie' ? 'Radarr Management' : 'Sonarr Management'}
    </h3>
    {hasStandardMapping && (
      <ServarrPanel
        mediaId={mediaId}
        is4k={false}
        label="Standard"
        onChanged={onChanged}
      />
    )}
    {has4kMapping && (
      <ServarrPanel mediaId={mediaId} is4k label="4K" onChanged={onChanged} />
    )}
  </div>
);

export default ServarrManagement;
