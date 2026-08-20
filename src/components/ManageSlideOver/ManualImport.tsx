import Button from '@app/components/Common/Button';
import useToasts from '@app/hooks/useToasts';
import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  formatSize,
  type Episode,
  type ImportCandidate,
  type ImportSource,
  type ServarrContext,
} from './servarrTypes';

const MANUAL_IMPORT_POLL_MS = 2000;
const MANUAL_IMPORT_POLL_DEADLINE_MS = 5 * 60 * 1000;

const errorMessage = (error: unknown, fallback: string) =>
  axios.isAxiosError(error)
    ? (error.response?.data?.message ?? fallback)
    : fallback;

const ManualImport = ({
  mediaId,
  is4k,
  context,
  onChanged,
  refreshToken,
}: {
  mediaId: number;
  is4k: boolean;
  context: ServarrContext;
  onChanged: () => void;
  refreshToken: number;
}) => {
  const { addToast } = useToasts();
  const sourcesAbortRef = useRef<AbortController | undefined>(undefined);
  const scanAbortRef = useRef<AbortController | undefined>(undefined);
  const reprocessAbortRef = useRef<AbortController | undefined>(undefined);
  const submitAbortRef = useRef<AbortController | undefined>(undefined);
  const pollRef = useRef<{
    timeoutId?: number;
    controller?: AbortController;
    cancelled: boolean;
  }>({ cancelled: false });
  const [sources, setSources] = useState<ImportSource[]>([]);
  const [availabilityError, setAvailabilityError] = useState<string>();
  const [refreshingSources, setRefreshingSources] = useState(false);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [selectedSource, setSelectedSource] = useState<string>();
  const [sourceLabel, setSourceLabel] = useState<string>();
  const [candidates, setCandidates] = useState<ImportCandidate[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [episodeMappings, setEpisodeMappings] = useState<
    Record<string, number[]>
  >({});
  const [mode, setMode] = useState<'move' | 'copy'>('move');
  const [importStatus, setImportStatus] = useState<string>();
  const [error, setError] = useState<string>();
  const [scanning, setScanning] = useState(false);
  const [rematchingToken, setRematchingToken] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [polling, setPolling] = useState(false);

  const refreshSources = useCallback(async () => {
    sourcesAbortRef.current?.abort();
    const controller = new AbortController();
    sourcesAbortRef.current = controller;
    setRefreshingSources(true);
    try {
      const response = await axios.get<{ sources: ImportSource[] }>(
        `/api/v1/media/${mediaId}/servarr/imports/sources?is4k=${is4k}`,
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      setSources(response.data.sources);
      setSelectedSource((current) =>
        response.data.sources.some((source) => source.token === current)
          ? current
          : response.data.sources[0]?.token
      );
      setAvailabilityError(undefined);
    } catch (error) {
      if (controller.signal.aborted) return;
      setSources([]);
      setAvailabilityError(
        errorMessage(
          error,
          'Unable to check whether a download needs manual import.'
        )
      );
    } finally {
      if (!controller.signal.aborted) setRefreshingSources(false);
    }
  }, [is4k, mediaId]);

  const cancelPolling = useCallback(() => {
    const state = pollRef.current;
    state.cancelled = true;
    state.controller?.abort();
    if (state.timeoutId !== undefined) window.clearTimeout(state.timeoutId);
  }, []);

  useEffect(() => {
    void refreshSources();
    return () => {
      sourcesAbortRef.current?.abort();
      scanAbortRef.current?.abort();
      reprocessAbortRef.current?.abort();
      submitAbortRef.current?.abort();
      cancelPolling();
    };
  }, [cancelPolling, refreshSources]);

  useEffect(() => {
    if (refreshToken > 0) void refreshSources();
  }, [refreshSources, refreshToken]);

  const openWorkflow = () => {
    setError(undefined);
    setCandidates([]);
    setSelected([]);
    setSourceLabel(undefined);
    setWorkflowOpen(true);
  };

  const scanSource = async () => {
    if (!selectedSource) return;
    scanAbortRef.current?.abort();
    const controller = new AbortController();
    scanAbortRef.current = controller;
    setScanning(true);
    setError(undefined);
    try {
      const response = await axios.post<{
        source: string;
        candidates: ImportCandidate[];
      }>(
        `/api/v1/media/${mediaId}/servarr/imports/scan`,
        { is4k, sourceToken: selectedSource },
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      setSourceLabel(response.data.source);
      setCandidates(response.data.candidates);
      setSelected([]);
      setEpisodeMappings({});
    } catch (error) {
      if (controller.signal.aborted) return;
      setError(errorMessage(error, 'Unable to scan this import source.'));
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        setWorkflowOpen(false);
        void refreshSources();
      }
    } finally {
      if (!controller.signal.aborted) setScanning(false);
    }
  };

  const rematchCandidate = async (candidate: ImportCandidate) => {
    const episodeIds =
      episodeMappings[candidate.token] ??
      candidate.episodes?.map((episode) => episode.id) ??
      [];
    if (!episodeIds.length) {
      setError('Choose at least one episode before rematching.');
      return;
    }
    reprocessAbortRef.current?.abort();
    const controller = new AbortController();
    reprocessAbortRef.current = controller;
    setRematchingToken(candidate.token);
    setError(undefined);
    try {
      const response = await axios.post<ImportCandidate>(
        `/api/v1/media/${mediaId}/servarr/imports/reprocess`,
        { is4k, candidateToken: candidate.token, episodeIds },
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;
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
    } catch (error) {
      if (!controller.signal.aborted)
        setError(errorMessage(error, 'Sonarr could not rematch this file.'));
    } finally {
      if (!controller.signal.aborted) setRematchingToken(undefined);
    }
  };

  const beginPolling = (commandToken: string) => {
    cancelPolling();
    const state = pollRef.current;
    state.cancelled = false;
    const startedAt = Date.now();
    setPolling(true);
    const poll = async () => {
      if (state.cancelled) return;
      if (Date.now() - startedAt > MANUAL_IMPORT_POLL_DEADLINE_MS) {
        setError('Manual import status check timed out.');
        setPolling(false);
        return;
      }
      const controller = new AbortController();
      state.controller = controller;
      try {
        const response = await axios.get<{ status: string; message?: string }>(
          `/api/v1/media/${mediaId}/servarr/commands/${commandToken}?is4k=${is4k}`,
          { signal: controller.signal }
        );
        if (state.cancelled || controller.signal.aborted) return;
        setImportStatus(response.data.status);
        if (['completed', 'failed', 'aborted'].includes(response.data.status)) {
          if (response.data.status === 'completed') {
            addToast('Manual import completed.', {
              appearance: 'success',
              autoDismiss: true,
            });
            void refreshSources();
            onChanged();
          } else setError(response.data.message ?? 'Manual import failed.');
          setPolling(false);
          return;
        }
        state.timeoutId = window.setTimeout(
          () => void poll(),
          MANUAL_IMPORT_POLL_MS
        );
      } catch (error) {
        if (!state.cancelled && !controller.signal.aborted) {
          setError(errorMessage(error, 'Unable to read manual import status.'));
          setPolling(false);
        }
      }
    };
    state.timeoutId = window.setTimeout(
      () => void poll(),
      MANUAL_IMPORT_POLL_MS
    );
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
    submitAbortRef.current?.abort();
    const controller = new AbortController();
    submitAbortRef.current = controller;
    setSubmitting(true);
    setError(undefined);
    try {
      const response = await axios.post<{
        status?: string;
        commandToken: string;
      }>(
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
        },
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      addToast(`Manual import queued (${response.data.status ?? 'queued'}).`, {
        appearance: 'success',
        autoDismiss: true,
      });
      setSelected([]);
      setImportStatus(response.data.status ?? 'queued');
      setCandidates([]);
      setWorkflowOpen(false);
      void refreshSources();
      onChanged();
      beginPolling(response.data.commandToken);
    } catch (error) {
      if (!controller.signal.aborted)
        setError(errorMessage(error, 'Unable to submit manual import.'));
    } finally {
      if (!controller.signal.aborted) setSubmitting(false);
    }
  };

  const episodes = context.seasons?.flatMap((season) => season.episodes) ?? [];
  const isBusy = scanning || submitting || polling;

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {sources.length > 0 && (
          <Button
            buttonType="default"
            className="border-yellow-700 text-yellow-200 hover:bg-yellow-950/40"
            onClick={openWorkflow}
          >
            Manual Import ({sources.length})
          </Button>
        )}
      </div>
      {availabilityError && (
        <div className="flex items-center gap-2 text-xs text-yellow-300">
          <span>{availabilityError}</span>
          <button
            className="underline hover:text-yellow-100"
            type="button"
            disabled={refreshingSources}
            onClick={() => void refreshSources()}
          >
            Retry
          </button>
        </div>
      )}
      {error && <div className="text-sm text-red-300">{error}</div>}
      {importStatus && (
        <div className="text-sm text-gray-300">
          Manual import: {importStatus}
        </div>
      )}
      {workflowOpen && sources.length > 0 && !candidates.length && (
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
            disabled={scanning}
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
            disabled={!selectedSource || scanning}
            onClick={() => void scanSource()}
          >
            Review files
          </Button>
        </div>
      )}
      {sourceLabel && !scanning && candidates.length === 0 && (
        <div className="rounded border border-gray-700 p-3 text-sm text-gray-300">
          {context.service.name} found no manual-import candidates in{' '}
          {sourceLabel}.
        </div>
      )}
      {candidates.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm text-gray-300">
            <span>Review from {sourceLabel}</span>
            <Button
              buttonType="default"
              buttonSize="sm"
              disabled={isBusy}
              onClick={() => {
                setCandidates([]);
                setSourceLabel(undefined);
                setWorkflowOpen(true);
              }}
            >
              Change source
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={mode}
              disabled={submitting}
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
              disabled={
                !selected.length || submitting || rematchingToken !== undefined
              }
              onClick={() => void submitImport()}
            >
              Import selected ({selected.length})
            </Button>
          </div>
          {candidates.map((candidate) => {
            const assigned =
              episodeMappings[candidate.token] ??
              candidate.episodes?.map((episode) => episode.id) ??
              [];
            return (
              <div
                key={candidate.token}
                className="block rounded border border-gray-700 p-2 text-sm"
              >
                <label>
                  <input
                    className="mr-2"
                    type="checkbox"
                    disabled={
                      !candidate.complete ||
                      submitting ||
                      rematchingToken !== undefined
                    }
                    checked={selected.includes(candidate.token)}
                    onChange={() =>
                      setSelected((current) =>
                        current.includes(candidate.token)
                          ? current.filter((token) => token !== candidate.token)
                          : [...current, candidate.token]
                      )
                    }
                  />
                  <span className="font-medium text-white">
                    {candidate.name}
                  </span>
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
                    Arr needs additional metadata for this file. Open it in Arr
                    to complete the import.
                  </div>
                )}
                {context.mediaType === 'tv' &&
                  (selected.includes(candidate.token) ||
                    !candidate.complete) && (
                    <div className="ml-6 mt-2 rounded border border-gray-600 p-2">
                      <div className="mb-1 text-xs font-medium uppercase tracking-wide text-gray-400">
                        Sonarr episode assignment
                      </div>
                      <div className="max-h-40 space-y-1 overflow-y-auto">
                        {episodes.map((episode: Episode) => (
                          <label key={episode.id} className="block">
                            <input
                              className="mr-2"
                              type="checkbox"
                              disabled={rematchingToken === candidate.token}
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
                        ))}
                      </div>
                      <Button
                        className="mt-2"
                        buttonType="default"
                        buttonSize="sm"
                        disabled={rematchingToken !== undefined || submitting}
                        onClick={() => void rematchCandidate(candidate)}
                      >
                        {rematchingToken === candidate.token
                          ? 'Applying…'
                          : 'Apply with Sonarr'}
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
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ManualImport;
