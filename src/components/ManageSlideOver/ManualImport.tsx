import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import SegmentedControl from '@app/components/Common/SegmentedControl';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowDownTrayIcon,
  DocumentMagnifyingGlassIcon,
} from '@heroicons/react/24/outline';
import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

import {
  formatSize,
  type Episode,
  type ImportCandidate,
  type ImportSource,
  type ServarrContext,
} from './servarrTypes';

const messages = defineMessages('components.ManageSlideOver.ManualImport', {
  manualImport: 'Manual Import ({count})',
  noSources: 'No download is waiting for a manual import.',
  availabilityFailed: 'Unable to check whether a download needs manual import.',
  retry: 'Retry',
  status: 'Manual import: {status}',
  chooseSource: 'Choose an import source',
  chooseSourceDescription:
    'Foreseerr asks {service} to scan the selected download; it does not inspect your filesystem itself.',
  importSource: 'Import source',
  download: 'Download: {label}',
  reviewFiles: 'Review Files',
  scanning: 'Scanning…',
  scanFailed: 'Unable to scan this import source.',
  noCandidates: '{service} found no manual-import candidates in {source}.',
  reviewFrom: 'Review from {source}',
  changeSource: 'Change Source',
  importMode: 'Import mode',
  moveFiles: 'Move Files',
  copyFiles: 'Copy Files',
  importSelected: 'Import Selected ({count})',
  confirmTitle:
    '{mode, select, copy {Copy} other {Move}} {count, plural, one {# file} other {# files}}?',
  confirmDescription:
    '{service} will {mode, select, copy {copy} other {move}} the selected files.',
  confirmDescriptionWarnings:
    '{service} will {mode, select, copy {copy} other {move}} the selected files even though it reported warnings.',
  cancel: 'Cancel',
  importNow: 'Import',
  importing: 'Importing…',
  unknownQuality: 'Unknown quality',
  unknownLanguage: 'Unknown language',
  customFormatScore: 'CF {score}',
  incomplete:
    '{service} needs additional metadata for this file. Open it in {service} to complete the import.',
  episodeAssignment: 'Episode Assignment',
  applyEpisodes: 'Apply with {service}',
  applying: 'Applying…',
  chooseEpisodeFirst: 'Choose at least one episode before rematching.',
  rematchFailed: '{service} could not rematch this file.',
  pollTimeout: 'Manual import status check timed out.',
  importCompleted: 'Manual import completed.',
  importFailed: 'Manual import failed.',
  statusFailed: 'Unable to read manual import status.',
  importQueued: 'Manual import queued.',
  submitFailed: 'Unable to submit manual import.',
});

const MANUAL_IMPORT_POLL_MS = 2000;
const MANUAL_IMPORT_POLL_DEADLINE_MS = 2 * 60 * 60 * 1000;

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
  interventionId,
}: {
  mediaId: number;
  is4k: boolean;
  context: ServarrContext;
  onChanged: () => void;
  refreshToken: number;
  interventionId?: number;
}) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  // Interventions open straight into the import workflow; the panel inside
  // Manage keeps it behind a button so it only appears when needed.
  const startOpen = interventionId !== undefined;
  const service = context.service.name;
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
  const [sourcesLoaded, setSourcesLoaded] = useState(false);
  const [availabilityError, setAvailabilityError] = useState<string>();
  const [refreshingSources, setRefreshingSources] = useState(false);
  const [workflowOpen, setWorkflowOpen] = useState(startOpen);
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
  const [confirmOpen, setConfirmOpen] = useState(false);

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
        errorMessage(error, intl.formatMessage(messages.availabilityFailed))
      );
    } finally {
      if (!controller.signal.aborted) {
        setRefreshingSources(false);
        setSourcesLoaded(true);
      }
    }
  }, [intl, is4k, mediaId]);

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
      setError(errorMessage(error, intl.formatMessage(messages.scanFailed)));
      if (axios.isAxiosError(error) && error.response?.status === 409) {
        setWorkflowOpen(startOpen);
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
      setError(intl.formatMessage(messages.chooseEpisodeFirst));
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
        setError(
          errorMessage(
            error,
            intl.formatMessage(messages.rematchFailed, { service })
          )
        );
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
        setError(intl.formatMessage(messages.pollTimeout));
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
            addToast(intl.formatMessage(messages.importCompleted), {
              appearance: 'success',
              autoDismiss: true,
            });
            void refreshSources();
            onChanged();
          } else
            setError(
              response.data.message ?? intl.formatMessage(messages.importFailed)
            );
          setPolling(false);
          return;
        }
        state.timeoutId = window.setTimeout(
          () => void poll(),
          MANUAL_IMPORT_POLL_MS
        );
      } catch (error) {
        if (!state.cancelled && !controller.signal.aborted) {
          setError(
            errorMessage(error, intl.formatMessage(messages.statusFailed))
          );
          setPolling(false);
        }
      }
    };
    state.timeoutId = window.setTimeout(
      () => void poll(),
      MANUAL_IMPORT_POLL_MS
    );
  };

  const selectedFiles = candidates.filter((candidate) =>
    selected.includes(candidate.token)
  );
  const selectedWarnings = selectedFiles.flatMap((candidate) =>
    candidate.rejections.map((rejection) => rejection.reason)
  );

  const submitImport = async () => {
    setConfirmOpen(false);
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
          acknowledgeRejections: selectedWarnings.length > 0,
          episodeMappings: Object.entries(episodeMappings)
            .filter(([token]) => selected.includes(token))
            .map(([candidateToken, episodeIds]) => ({
              candidateToken,
              episodeIds,
            })),
          interventionId,
        },
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      addToast(intl.formatMessage(messages.importQueued), {
        appearance: 'success',
        autoDismiss: true,
      });
      setSelected([]);
      setImportStatus(response.data.status ?? 'queued');
      setCandidates([]);
      setWorkflowOpen(startOpen);
      void refreshSources();
      onChanged();
      beginPolling(response.data.commandToken);
    } catch (error) {
      if (!controller.signal.aborted)
        setError(
          errorMessage(error, intl.formatMessage(messages.submitFailed))
        );
    } finally {
      if (!controller.signal.aborted) setSubmitting(false);
    }
  };

  const episodes = context.seasons?.flatMap((season) => season.episodes) ?? [];
  const isBusy = scanning || submitting || polling;

  return (
    <div className="space-y-3">
      {!startOpen && sources.length > 0 && !workflowOpen && (
        <Button buttonType="warning" className="w-full" onClick={openWorkflow}>
          <ArrowDownTrayIcon />
          <span>
            {intl.formatMessage(messages.manualImport, {
              count: sources.length,
            })}
          </span>
        </Button>
      )}
      {startOpen &&
        sourcesLoaded &&
        !availabilityError &&
        !sources.length &&
        !importStatus && (
          <p className="text-sm text-gray-400">
            {intl.formatMessage(messages.noSources)}
          </p>
        )}
      {availabilityError && (
        <Alert type="warning" title={availabilityError}>
          <button
            className="font-medium underline hover:text-yellow-100"
            type="button"
            disabled={refreshingSources}
            onClick={() => void refreshSources()}
          >
            {intl.formatMessage(messages.retry)}
          </button>
        </Alert>
      )}
      {error && <Alert type="error" title={error} />}
      {importStatus && (
        <p className="text-sm text-gray-300">
          {intl.formatMessage(messages.status, { status: importStatus })}
        </p>
      )}
      {workflowOpen && sources.length > 0 && !candidates.length && (
        <div className="space-y-3 rounded-md border border-gray-700 bg-gray-800 p-4 shadow">
          <div>
            <div className="font-semibold text-white">
              {intl.formatMessage(messages.chooseSource)}
            </div>
            <p className="mt-1 text-sm text-gray-400">
              {intl.formatMessage(messages.chooseSourceDescription, {
                service,
              })}
            </p>
          </div>
          <select
            aria-label={intl.formatMessage(messages.importSource)}
            value={selectedSource}
            onChange={(event) => setSelectedSource(event.target.value)}
            disabled={scanning}
          >
            {sources.map((source) => (
              <option key={source.token} value={source.token}>
                {intl.formatMessage(messages.download, { label: source.label })}
              </option>
            ))}
          </select>
          <div className="flex justify-end gap-2">
            {!startOpen && (
              <Button
                disabled={scanning}
                onClick={() => setWorkflowOpen(false)}
              >
                {intl.formatMessage(messages.cancel)}
              </Button>
            )}
            <Button
              buttonType="primary"
              disabled={!selectedSource || scanning}
              onClick={() => void scanSource()}
            >
              <DocumentMagnifyingGlassIcon />
              <span>
                {intl.formatMessage(
                  scanning ? messages.scanning : messages.reviewFiles
                )}
              </span>
            </Button>
          </div>
        </div>
      )}
      {sourceLabel && !scanning && candidates.length === 0 && (
        <p className="text-sm text-gray-400">
          {intl.formatMessage(messages.noCandidates, {
            service,
            source: sourceLabel,
          })}
        </p>
      )}
      {candidates.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-sm text-gray-300">
              {intl.formatMessage(messages.reviewFrom, { source: sourceLabel })}
            </span>
            <Button
              buttonSize="sm"
              disabled={isBusy}
              onClick={() => {
                setCandidates([]);
                setSourceLabel(undefined);
                setConfirmOpen(false);
                setWorkflowOpen(true);
              }}
            >
              {intl.formatMessage(messages.changeSource)}
            </Button>
          </div>
          <SegmentedControl<'move' | 'copy'>
            ariaLabel={intl.formatMessage(messages.importMode)}
            size="sm"
            value={mode}
            onChange={(value) => {
              if (!submitting) setMode(value);
            }}
            options={[
              { value: 'move', label: intl.formatMessage(messages.moveFiles) },
              { value: 'copy', label: intl.formatMessage(messages.copyFiles) },
            ]}
          />
          {confirmOpen ? (
            <div className="space-y-3 rounded-md border border-gray-600 bg-gray-900/80 p-4 text-sm shadow">
              <div className="font-semibold text-white">
                {intl.formatMessage(messages.confirmTitle, {
                  mode,
                  count: selectedFiles.length,
                })}
              </div>
              <p className="text-gray-300">
                {intl.formatMessage(
                  selectedWarnings.length
                    ? messages.confirmDescriptionWarnings
                    : messages.confirmDescription,
                  { service, mode }
                )}
              </p>
              {selectedWarnings.length > 0 && (
                <ul className="list-disc space-y-1 pl-5 text-yellow-300">
                  {selectedWarnings.map((warning, index) => (
                    <li key={`${index}-${warning}`}>{warning}</li>
                  ))}
                </ul>
              )}
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  buttonSize="sm"
                  disabled={submitting}
                  onClick={() => setConfirmOpen(false)}
                >
                  {intl.formatMessage(messages.cancel)}
                </Button>
                <Button
                  type="button"
                  buttonType="success"
                  buttonSize="sm"
                  disabled={!selectedFiles.length || submitting}
                  onClick={() => void submitImport()}
                >
                  <ArrowDownTrayIcon />
                  <span>
                    {intl.formatMessage(
                      submitting ? messages.importing : messages.importNow
                    )}
                  </span>
                </Button>
              </div>
            </div>
          ) : (
            <Button
              buttonType="success"
              className="w-full"
              type="button"
              disabled={
                !selected.length || submitting || rematchingToken !== undefined
              }
              onClick={() => setConfirmOpen(true)}
            >
              <ArrowDownTrayIcon />
              <span>
                {intl.formatMessage(messages.importSelected, {
                  count: selected.length,
                })}
              </span>
            </Button>
          )}
          <ul className="divide-y divide-gray-700 overflow-hidden rounded-md border border-gray-700 shadow">
            {candidates.map((candidate) => {
              const assigned =
                episodeMappings[candidate.token] ??
                candidate.episodes?.map((episode) => episode.id) ??
                [];
              const checkboxId = `manual-import-${candidate.token}`;
              return (
                <li key={candidate.token} className="px-4 py-3 text-sm">
                  <div className="flex items-start gap-3">
                    <input
                      id={checkboxId}
                      type="checkbox"
                      className="mt-0.5 flex-none"
                      disabled={
                        !candidate.complete ||
                        submitting ||
                        rematchingToken !== undefined
                      }
                      checked={selected.includes(candidate.token)}
                      onChange={() =>
                        setSelected((current) =>
                          current.includes(candidate.token)
                            ? current.filter(
                                (token) => token !== candidate.token
                              )
                            : [...current, candidate.token]
                        )
                      }
                    />
                    <label
                      htmlFor={checkboxId}
                      className="mb-0 min-w-0 flex-1 font-normal"
                    >
                      <span className="block break-all font-medium text-white">
                        {candidate.name}
                      </span>
                      <span className="block text-xs text-gray-400">
                        {[
                          formatSize(candidate.size),
                          candidate.quality ??
                            intl.formatMessage(messages.unknownQuality),
                          candidate.source,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      <span className="block text-xs text-gray-400">
                        {[
                          candidate.languages.join(', ') ||
                            intl.formatMessage(messages.unknownLanguage),
                          candidate.customFormats.join(', '),
                          candidate.customFormatScore !== undefined
                            ? intl.formatMessage(messages.customFormatScore, {
                                score: candidate.customFormatScore,
                              })
                            : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </label>
                  </div>
                  <div className="ml-9 space-y-2">
                    {!candidate.complete && (
                      <p className="mt-1 text-xs text-yellow-300">
                        {intl.formatMessage(messages.incomplete, { service })}
                      </p>
                    )}
                    {candidate.rejections.length > 0 && (
                      <p className="mt-1 text-xs text-yellow-300">
                        {candidate.rejections
                          .map((rejection) => rejection.reason)
                          .join(' • ')}
                      </p>
                    )}
                    {context.mediaType === 'tv' &&
                      (selected.includes(candidate.token) ||
                        !candidate.complete) && (
                        <div className="mt-2 rounded-md border border-gray-700 bg-gray-800 p-3">
                          <div className="mb-2 text-sm font-semibold text-gray-200">
                            {intl.formatMessage(messages.episodeAssignment)}
                          </div>
                          <div className="max-h-40 space-y-1 overflow-y-auto">
                            {episodes.map((episode: Episode) => (
                              <label
                                key={episode.id}
                                className="mb-0 flex items-center gap-2 font-normal text-gray-300"
                              >
                                <input
                                  type="checkbox"
                                  className="flex-none"
                                  disabled={rematchingToken === candidate.token}
                                  checked={assigned.includes(episode.id)}
                                  onChange={() =>
                                    setEpisodeMappings((current) => {
                                      const ids =
                                        current[candidate.token] ?? assigned;
                                      return {
                                        ...current,
                                        [candidate.token]: ids.includes(
                                          episode.id
                                        )
                                          ? ids.filter(
                                              (id) => id !== episode.id
                                            )
                                          : [...ids, episode.id],
                                      };
                                    })
                                  }
                                />
                                <span className="truncate">
                                  S
                                  {String(episode.seasonNumber).padStart(
                                    2,
                                    '0'
                                  )}
                                  E
                                  {String(episode.episodeNumber).padStart(
                                    2,
                                    '0'
                                  )}{' '}
                                  — {episode.title}
                                </span>
                              </label>
                            ))}
                          </div>
                          <Button
                            className="mt-3"
                            buttonSize="sm"
                            disabled={
                              rematchingToken !== undefined || submitting
                            }
                            onClick={() => void rematchCandidate(candidate)}
                          >
                            {rematchingToken === candidate.token
                              ? intl.formatMessage(messages.applying)
                              : intl.formatMessage(messages.applyEpisodes, {
                                  service,
                                })}
                          </Button>
                        </div>
                      )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
};

export default ManualImport;
