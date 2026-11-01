import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import SegmentedControl from '@app/components/Common/SegmentedControl';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  CheckCircleIcon,
  DocumentMagnifyingGlassIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import EpisodeAssignmentPicker from './EpisodeAssignmentPicker';
import { explainRejections, rejectionMessages } from './rejectionExplanations';

import {
  formatSize,
  type ImportCandidate,
  type ImportOptions,
  type ImportSource,
  type ServarrContext,
} from './servarrTypes';

const messages = defineMessages('components.ManageSlideOver.ManualImport', {
  manualImport: 'Manual Import ({count})',
  noSources: 'No download is waiting for a manual import.',
  availabilityFailed: 'Unable to check whether a download needs manual import.',
  retry: 'Retry',
  jobQueued:
    'Waiting for {service} to start importing {count, plural, one {# file} other {# files}}…',
  jobStarted:
    '{service} is {mode, select, copy {copying} other {moving}} {count, plural, one {# file} other {# files}} into your library…',
  jobCompleted:
    '{count, plural, one {# file} other {# files}} imported into your library.',
  jobFailed: '{service} could not import the files.',
  jobUnknown: "Foreseerr couldn't confirm whether the import finished.",
  jobResolving: 'This warning will clear from the list in a moment.',
  reviewAgain: 'Review files again',
  dismiss: 'Done',
  chooseSource: 'Choose an import source',
  waitingSource: 'Download waiting for import',
  chooseSourceDescription:
    'Foreseerr asks {service} to scan the selected download; it does not inspect your filesystem itself.',
  importSource: 'Import source',
  download: 'Download: {label}',
  reviewFiles: 'Review Files',
  scanning: 'Scanning…',
  scanningSource: 'Asking {service} for the files in {source}…',
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
  chooseDetails:
    "{service} couldn't detect everything about this file. Choose what's missing below.",
  quality: 'Quality',
  language: 'Language',
  chooseQuality: 'Choose a quality',
  chooseLanguage: 'Choose a language',
  optionsFailed: 'Unable to load the qualities and languages of {service}.',
  incomplete:
    '{service} needs additional metadata for this file. Open it in {service} to complete the import.',
  episodeAssignment: 'Episode Assignment',
  rematching: 'Matching with {service}…',
  noEpisodes: 'No episodes assigned yet',
  moreEpisodes: '{list} and {count, plural, one {# more} other {# more}}',
  changeEpisodes: 'Change',
  doneEpisodes: 'Done',
  numberFiles:
    'Number the {count, plural, one {# selected file} other {# selected files}} in order',
  numberFilesHint:
    'For a season pack {service} misread: files are sorted by name and given one episode each, starting from the episode you choose.',
  firstEpisode: 'Choose the first episode',
  assign: 'Assign',
  numberFilesPreview:
    '{first} to {last} for the {count, plural, one {# file} other {# files}}, in name order.',
  numberFilesShort:
    'There are fewer episodes than {count, plural, one {# file} other {# files}} from this one on.',
  confirmEpisodes:
    '{count, plural, one {Use this episode} other {Use these # episodes}}',
  pickEpisodes: 'Pick the episodes this file holds so {service} can import it.',
  notReady:
    "{count, plural, one {# selected file isn't} other {# selected files aren't}} ready to import yet.",
  waitingForRematch: 'Waiting for {service} to match the episodes you picked…',
  rematchFailed: '{service} could not rematch this file.',
  pollTimeout: 'Manual import status check timed out.',
  importCompleted: 'Manual import completed.',
  importFailed: 'Manual import failed.',
  statusFailed: 'Unable to read manual import status.',
  submitFailed: 'Unable to submit manual import.',
  title: 'Import downloaded files',
  description:
    'Review a completed download and choose which files {service} should add to your library.',
  checking: 'Checking for completed downloads…',
  refresh: 'Check downloads again',
  selectAll: 'Select all ready files',
  selectedCount:
    '{selected, number} of {total, plural, one {# file selected} other {# files selected}}',
  moveHint:
    'Move removes the files from the download folder after adding them to your library.',
  copyHint: 'Copy keeps the original files in the download folder.',
  multiSeasonHint:
    "This file comes from a multi-season download, which {service} won't import automatically. Check the episodes it holds, then apply them before importing.",
});

const MANUAL_IMPORT_POLL_MS = 2000;
// How long episode picks settle before Sonarr rematches the file.
const REMATCH_DELAY_MS = 600;
const MANUAL_IMPORT_POLL_DEADLINE_MS = 2 * 60 * 60 * 1000;

const errorMessage = (error: unknown, fallback: string) =>
  axios.isAxiosError(error)
    ? (error.response?.data?.message ?? fallback)
    : fallback;

// Files ready to import start selected, like Sonarr's own manual import:
// those without warnings, or every ready one when opened from an
// intervention, whose warnings are the reason it is being resolved (the
// confirmation still lists them).
const initialSelection = (
  candidates: ImportCandidate[],
  includeWarnings: boolean
) =>
  candidates
    .filter(
      (candidate) =>
        candidate.complete &&
        !candidate.unsafe &&
        !candidate.multiSeason &&
        (includeWarnings || !candidate.rejections.length)
    )
    .map((candidate) => candidate.token);

const ManualImport = ({
  mediaId,
  is4k,
  context,
  onChanged,
  refreshToken,
  interventionId,
  onSourceCountChanged,
}: {
  mediaId: number;
  is4k: boolean;
  context: ServarrContext;
  onChanged: () => void;
  refreshToken: number;
  interventionId?: number;
  onSourceCountChanged?: (count: number) => void;
}) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  // Interventions open straight into the import workflow; the panel inside
  // Manage keeps it behind a button so it only appears when needed.
  const startOpen = interventionId !== undefined;
  const service = context.service.name;
  const sourcesAbortRef = useRef<AbortController | undefined>(undefined);
  const scanAbortRef = useRef<AbortController | undefined>(undefined);
  const reprocessAbortRef = useRef(new Map<string, AbortController>());
  const rematchTimersRef = useRef(new Map<string, number>());
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
  // The submitted import, until it is dismissed or reviewed again.
  const [importJob, setImportJob] = useState<{
    count: number;
    mode: 'move' | 'copy';
    status: string;
    message?: string;
  }>();
  const lastSourceRef = useRef<string>(undefined);
  const [error, setError] = useState<string>();
  const [scanning, setScanning] = useState(false);
  // Files waiting for their picks to settle, and files being rematched.
  const [pendingRematch, setPendingRematch] = useState<Set<string>>(new Set());
  const [rematching, setRematching] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [bulkStart, setBulkStart] = useState('');
  // A quality or language picked for a file the Arr couldn't detect one for.
  const [overrides, setOverrides] = useState<
    Record<string, { qualityId?: number; languageIds?: number[] }>
  >({});
  const [options, setOptions] = useState<ImportOptions>();
  const optionsRequestedRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [polling, setPolling] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  const importTriggerRef = useRef<HTMLButtonElement>(null);
  useEffect(
    () => onSourceCountChanged?.(sources.length),
    [onSourceCountChanged, sources.length]
  );
  useEffect(() => {
    if (confirmOpen) confirmCancelRef.current?.focus({ preventScroll: true });
  }, [confirmOpen]);
  const dismissConfirmation = () => {
    setConfirmOpen(false);
    window.requestAnimationFrame(() =>
      importTriggerRef.current?.focus({ preventScroll: true })
    );
  };

  const refreshSources = useCallback(async () => {
    sourcesAbortRef.current?.abort();
    const controller = new AbortController();
    sourcesAbortRef.current = controller;
    setRefreshingSources(true);
    try {
      const response = await axios.get<{ sources: ImportSource[] }>(
        `/api/v1/media/${mediaId}/servarr/imports/sources?is4k=${is4k}${
          interventionId !== undefined
            ? `&interventionId=${interventionId}`
            : ''
        }`,
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
  }, [interventionId, intl, is4k, mediaId]);

  const cancelRematches = useCallback(() => {
    reprocessAbortRef.current.forEach((controller) => controller.abort());
    reprocessAbortRef.current.clear();
    rematchTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    rematchTimersRef.current.clear();
    setPendingRematch(new Set());
    setRematching(new Set());
  }, []);

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
      submitAbortRef.current?.abort();
      cancelRematches();
      cancelPolling();
    };
  }, [cancelPolling, cancelRematches, refreshSources]);

  useEffect(() => {
    if (refreshToken > 0) void refreshSources();
  }, [refreshSources, refreshToken]);

  const scanSource = async (sourceToken = selectedSource) => {
    if (!sourceToken) return;
    lastSourceRef.current = sourceToken;
    scanAbortRef.current?.abort();
    const controller = new AbortController();
    scanAbortRef.current = controller;
    cancelRematches();
    setScanning(true);
    setError(undefined);
    try {
      const response = await axios.post<{
        source: string;
        candidates: ImportCandidate[];
      }>(
        `/api/v1/media/${mediaId}/servarr/imports/scan`,
        { is4k, sourceToken },
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      setSourceLabel(response.data.source);
      setCandidates(response.data.candidates);
      setSelected(initialSelection(response.data.candidates, startOpen));
      setEpisodeMappings({});
      setOverrides({});
      setExpanded(new Set());
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

  const openWorkflow = () => {
    setError(undefined);
    setCandidates([]);
    setSelected([]);
    setSourceLabel(undefined);
    setWorkflowOpen(true);
    // A single download needs no choosing: review its files straight away.
    if (sources.length === 1) void scanSource(sources[0].token);
  };

  // An intervention names its download, so its files are scanned as soon
  // as the download is confirmed to still be waiting.
  const autoScannedRef = useRef(false);
  useEffect(() => {
    if (!startOpen || autoScannedRef.current || sources.length !== 1) return;
    autoScannedRef.current = true;
    void scanSource(sources[0].token);
    // scanSource is recreated each render; the ref keeps this to one scan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources, startOpen]);

  const moveToken = <T,>(items: Set<T> | T[], from: T, to: T) =>
    [...items].map((item) => (item === from ? to : item));

  // Sonarr rematches a file as soon as its episodes are picked, as in its
  // own manual import, so the warnings shown are always for the current
  // assignment.
  const rematchCandidate = async (token: string, episodeIds: number[]) => {
    const controller = new AbortController();
    reprocessAbortRef.current.set(token, controller);
    setRematching((current) => new Set(current).add(token));
    setError(undefined);
    try {
      const response = await axios.post<ImportCandidate>(
        `/api/v1/media/${mediaId}/servarr/imports/reprocess`,
        { is4k, candidateToken: token, episodeIds },
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      const next = response.data;
      setCandidates((current) =>
        current.map((item) => (item.token === token ? next : item))
      );
      // A file that became importable is selected for import.
      setSelected((current) =>
        current.includes(token)
          ? moveToken(current, token, next.token)
          : next.complete && !next.unsafe
            ? [...current, next.token]
            : current
      );
      setEpisodeMappings((current) => {
        const { [token]: ids = episodeIds, ...rest } = current;
        return { ...rest, [next.token]: ids };
      });
      setExpanded((current) => new Set(moveToken(current, token, next.token)));
      setOverrides((current) => {
        const { [token]: choice, ...rest } = current;
        return choice ? { ...rest, [next.token]: choice } : rest;
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
      if (reprocessAbortRef.current.get(token) === controller) {
        reprocessAbortRef.current.delete(token);
        setRematching((current) => {
          const next = new Set(current);
          next.delete(token);
          return next;
        });
      }
    }
  };

  const chooseDetail = (
    candidate: ImportCandidate,
    choice: { qualityId?: number; languageIds?: number[] }
  ) => {
    const { token } = candidate;
    const next = { ...overrides[token], ...choice };
    setOverrides((current) => ({ ...current, [token]: next }));
    // Once nothing is left to choose, the file is selected for import.
    if (
      !candidate.unsafe &&
      (!candidate.missing?.includes('quality') ||
        next.qualityId !== undefined) &&
      (!candidate.missing?.includes('languages') || !!next.languageIds?.length)
    )
      setSelected((current) =>
        current.includes(token) ? current : [...current, token]
      );
  };

  const assignEpisodes = (candidate: ImportCandidate, ids: number[]) => {
    const { token } = candidate;
    setEpisodeMappings((current) => ({ ...current, [token]: ids }));
    setExpanded((current) => new Set(current).add(token));
    const timers = rematchTimersRef.current;
    window.clearTimeout(timers.get(token));
    timers.delete(token);
    const settled = () =>
      setPendingRematch((current) => {
        const next = new Set(current);
        next.delete(token);
        return next;
      });
    if (!ids.length) {
      settled();
      return;
    }
    setPendingRematch((current) => new Set(current).add(token));
    timers.set(
      token,
      window.setTimeout(() => {
        timers.delete(token);
        settled();
        void rematchCandidate(token, ids);
      }, REMATCH_DELAY_MS)
    );
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
        setImportJob(
          (job) =>
            job && {
              ...job,
              status: 'unknown',
              message: intl.formatMessage(messages.pollTimeout),
            }
        );
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
        const { status, message } = response.data;
        setImportJob((job) => job && { ...job, status, message });
        if (['completed', 'failed', 'aborted'].includes(status)) {
          if (status === 'completed') {
            addToast(intl.formatMessage(messages.importCompleted), {
              appearance: 'success',
              autoDismiss: true,
            });
            void refreshSources();
            onChanged();
          }
          setPolling(false);
          return;
        }
        state.timeoutId = window.setTimeout(
          () => void poll(),
          MANUAL_IMPORT_POLL_MS
        );
      } catch (error) {
        if (!state.cancelled && !controller.signal.aborted) {
          setImportJob(
            (job) =>
              job && {
                ...job,
                status: 'unknown',
                message: errorMessage(
                  error,
                  intl.formatMessage(messages.statusFailed)
                ),
              }
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

  // What is still missing once the user's picks are counted: picked
  // episodes stand in for the match, a chosen quality or language for the
  // undetected one.
  const stillMissing = (candidate: ImportCandidate) => {
    const mapped = !!episodeMappings[candidate.token]?.length;
    const choice = overrides[candidate.token];
    return (
      candidate.missing ?? (candidate.complete ? [] : ['unknown'])
    ).filter(
      (field) =>
        !(
          (mapped && ['series', 'seasonNumber', 'episodes'].includes(field)) ||
          (field === 'quality' && choice?.qualityId !== undefined) ||
          (field === 'languages' && !!choice?.languageIds?.length)
        )
    );
  };
  const needsDetails = candidates.some(
    (candidate) =>
      !candidate.unsafe &&
      candidate.missing?.some(
        (field) => field === 'quality' || field === 'languages'
      )
  );
  useEffect(() => {
    if (!needsDetails || optionsRequestedRef.current) return;
    optionsRequestedRef.current = true;
    axios
      .get<ImportOptions>(
        `/api/v1/media/${mediaId}/servarr/imports/options?is4k=${is4k}`
      )
      .then((response) => setOptions(response.data))
      .catch((requestError) => {
        optionsRequestedRef.current = false;
        setError(
          errorMessage(
            requestError,
            intl.formatMessage(messages.optionsFailed, { service })
          )
        );
      });
  }, [intl, is4k, mediaId, needsDetails, service]);

  // A flagged file is never imported; a multi-season one only to episodes
  // picked for it.
  const importable = (candidate: ImportCandidate) =>
    !stillMissing(candidate).length &&
    !candidate.unsafe &&
    !pendingRematch.has(candidate.token) &&
    !rematching.has(candidate.token) &&
    (!candidate.multiSeason ||
      (episodeMappings[candidate.token]?.length ?? 0) > 0);
  const explain = (candidate: ImportCandidate) =>
    explainRejections(
      intl,
      'import',
      candidate.rejections.map(({ reason, code }) => ({
        message: reason,
        code,
      })),
      service
    );
  const selectedFiles = candidates.filter((candidate) =>
    selected.includes(candidate.token)
  );
  const selectedWarnings = selectedFiles.flatMap((candidate) =>
    explain(candidate).map((rejection) => rejection.text)
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
          overrides: Object.entries(overrides)
            .filter(([token]) => selected.includes(token))
            .map(([candidateToken, choice]) => ({
              candidateToken,
              ...choice,
            })),
          interventionId,
        },
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      setImportJob({
        count: selected.length,
        mode,
        status: response.data.status?.toLowerCase() ?? 'queued',
      });
      setSelected([]);
      setCandidates([]);
      setSourceLabel(undefined);
      cancelRematches();
      setWorkflowOpen(startOpen);
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
  const episodeById = new Map(episodes.map((episode) => [episode.id, episode]));
  const assignedTo = (candidate: ImportCandidate) =>
    episodeMappings[candidate.token] ??
    candidate.episodes?.map((episode) => episode.id) ??
    [];
  // A file without episodes, or one from a multi-season download whose
  // episodes aren't confirmed, keeps its picker open.
  const unconfirmedMultiSeason = (candidate: ImportCandidate) =>
    !!candidate.multiSeason && !episodeMappings[candidate.token]?.length;
  const needsEpisodes = (candidate: ImportCandidate) =>
    !assignedTo(candidate).length || unconfirmedMultiSeason(candidate);
  const episodeCode = (episode: (typeof episodes)[number]) =>
    `S${String(episode.seasonNumber).padStart(2, '0')}E${String(episode.episodeNumber).padStart(2, '0')}`;
  const describeEpisodes = (ids: number[]) => {
    if (!ids.length) return intl.formatMessage(messages.noEpisodes);
    const labels = ids.map((id) => {
      const episode = episodeById.get(id);
      return episode ? episodeCode(episode) : `#${id}`;
    });
    return labels.length > 4
      ? intl.formatMessage(messages.moreEpisodes, {
          list: labels.slice(0, 3).join(', '),
          count: labels.length - 3,
        })
      : labels.join(', ');
  };
  const isBusy = scanning || submitting || polling;
  const jobFailed =
    !!importJob && ['failed', 'aborted', 'unknown'].includes(importJob.status);
  const sortedEpisodes = [...episodes].sort(
    (a, b) =>
      a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber
  );
  // A season pack Sonarr misparsed is fixed by numbering its files in
  // name order from one episode, rather than file by file.
  const bulkFiles = selectedFiles
    .filter((candidate) => !candidate.unsafe)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const bulkIndex = sortedEpisodes.findIndex(
    (episode) => String(episode.id) === bulkStart
  );
  const bulkEpisodes =
    bulkIndex === -1
      ? []
      : sortedEpisodes.slice(bulkIndex, bulkIndex + bulkFiles.length);
  const numberFiles = () => {
    if (bulkEpisodes.length !== bulkFiles.length) return;
    bulkFiles.forEach((file, index) =>
      assignEpisodes(file, [bulkEpisodes[index].id])
    );
  };
  const readyFiles = candidates.filter(importable);
  const notReady = selectedFiles.filter((candidate) => !importable(candidate));

  return (
    <div className="space-y-3">
      <div>
        <h4 className="font-semibold text-white">
          {intl.formatMessage(messages.title)}
        </h4>
        <p className="mt-1 text-sm text-gray-400">
          {intl.formatMessage(messages.description, { service })}
        </p>
      </div>
      {!startOpen && !importJob && sources.length > 0 && !workflowOpen && (
        <Button
          buttonType="primary"
          className="min-h-11 w-full"
          onClick={openWorkflow}
        >
          <ArrowDownTrayIcon />
          <span>
            {intl.formatMessage(messages.manualImport, {
              count: sources.length,
            })}
          </span>
        </Button>
      )}
      {/* Checking again only matters while nothing is under review. */}
      {!importJob && !candidates.length && !scanning && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-gray-400">
            {!sourcesLoaded
              ? intl.formatMessage(messages.checking)
              : !availabilityError && !sources.length
                ? intl.formatMessage(messages.noSources)
                : null}
          </p>
          <Button
            buttonSize="sm"
            className="min-h-11"
            disabled={refreshingSources || isBusy}
            aria-busy={refreshingSources}
            onClick={() => void refreshSources()}
          >
            <ArrowPathIcon
              className={refreshingSources ? 'animate-spin' : undefined}
            />
            <span>{intl.formatMessage(messages.refresh)}</span>
          </Button>
        </div>
      )}
      {availabilityError && (
        <Alert type="warning" title={availabilityError}>
          <button
            className="min-h-11 font-medium underline hover:text-yellow-100 focus-visible:ring-2 focus-visible:ring-indigo-500"
            type="button"
            disabled={refreshingSources}
            onClick={() => void refreshSources()}
          >
            {intl.formatMessage(messages.retry)}
          </button>
        </Alert>
      )}
      {error && <Alert type="error" title={error} />}
      {importJob && (
        <div
          role="status"
          className={`space-y-3 rounded-md border p-4 text-sm shadow ${
            importJob.status === 'completed'
              ? 'border-green-500/40 bg-green-500/10 text-green-100'
              : jobFailed
                ? 'border-red-500/40 bg-red-500/10 text-red-100'
                : 'border-gray-700 bg-gray-800 text-gray-200'
          }`}
        >
          <div className="flex items-center gap-2 font-semibold">
            {importJob.status === 'completed' ? (
              <CheckCircleIcon className="h-5 w-5 flex-none" />
            ) : jobFailed ? (
              <ExclamationTriangleIcon className="h-5 w-5 flex-none" />
            ) : (
              <ArrowPathIcon className="h-5 w-5 flex-none animate-spin" />
            )}
            <span>
              {intl.formatMessage(
                importJob.status === 'completed'
                  ? messages.jobCompleted
                  : importJob.status === 'started'
                    ? messages.jobStarted
                    : jobFailed
                      ? importJob.status === 'unknown'
                        ? messages.jobUnknown
                        : messages.jobFailed
                      : messages.jobQueued,
                { service, count: importJob.count, mode: importJob.mode }
              )}
            </span>
          </div>
          {jobFailed && (
            <p className="break-words">
              {importJob.message ?? intl.formatMessage(messages.importFailed)}
            </p>
          )}
          {importJob.status === 'completed' && startOpen && (
            <p>{intl.formatMessage(messages.jobResolving)}</p>
          )}
          {(jobFailed || (importJob.status === 'completed' && !startOpen)) && (
            <div className="flex flex-wrap justify-end gap-2">
              {jobFailed && lastSourceRef.current && (
                <Button
                  buttonSize="sm"
                  className="min-h-11"
                  onClick={() => {
                    setImportJob(undefined);
                    void scanSource(lastSourceRef.current);
                  }}
                >
                  {intl.formatMessage(messages.reviewAgain)}
                </Button>
              )}
              <Button
                buttonSize="sm"
                className="min-h-11"
                onClick={() => {
                  setImportJob(undefined);
                  void refreshSources();
                }}
              >
                {intl.formatMessage(messages.dismiss)}
              </Button>
            </div>
          )}
        </div>
      )}
      {scanning && (
        <p role="status" className="text-sm text-gray-300">
          {intl.formatMessage(messages.scanningSource, {
            service,
            source: (
              sources.find((source) => source.token === selectedSource) ??
              sources[0]
            )?.label,
          })}
        </p>
      )}
      {workflowOpen &&
        !importJob &&
        !scanning &&
        sources.length > 0 &&
        !candidates.length && (
          <div className="space-y-3 rounded-md border border-gray-700 bg-gray-800 p-4 shadow">
            <div>
              <div className="font-semibold text-white">
                {intl.formatMessage(
                  sources.length === 1
                    ? messages.waitingSource
                    : messages.chooseSource
                )}
              </div>
              <p className="mt-1 text-sm text-gray-400">
                {intl.formatMessage(messages.chooseSourceDescription, {
                  service,
                })}
              </p>
            </div>
            {sources.length === 1 ? (
              <p className="break-all font-mono text-xs text-gray-300">
                {sources[0].label}
              </p>
            ) : (
              <select
                className="min-h-11 w-full"
                aria-label={intl.formatMessage(messages.importSource)}
                value={selectedSource}
                onChange={(event) => setSelectedSource(event.target.value)}
                disabled={scanning}
              >
                {sources.map((source) => (
                  <option key={source.token} value={source.token}>
                    {intl.formatMessage(messages.download, {
                      label: source.label,
                    })}
                  </option>
                ))}
              </select>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              {!startOpen && (
                <Button
                  className="min-h-11"
                  disabled={scanning}
                  onClick={() => setWorkflowOpen(false)}
                >
                  {intl.formatMessage(messages.cancel)}
                </Button>
              )}
              <Button
                className="min-h-11"
                buttonType="primary"
                disabled={!selectedSource || scanning}
                onClick={() => void scanSource()}
                aria-busy={scanning}
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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="min-w-0 break-words text-sm text-gray-300">
              {intl.formatMessage(messages.reviewFrom, { source: sourceLabel })}
            </span>
            <Button
              buttonSize="sm"
              className="min-h-11"
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
            disabled={isBusy}
            ariaLabel={intl.formatMessage(messages.importMode)}
            value={mode}
            onChange={(value) => {
              if (!isBusy) setMode(value);
            }}
            options={[
              { value: 'move', label: intl.formatMessage(messages.moveFiles) },
              { value: 'copy', label: intl.formatMessage(messages.copyFiles) },
            ]}
          />
          <p className="text-xs text-gray-400">
            {intl.formatMessage(
              mode === 'move' ? messages.moveHint : messages.copyHint
            )}
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="mb-0 flex min-h-11 cursor-pointer items-center gap-2 text-sm font-normal text-gray-200">
              <input
                type="checkbox"
                disabled={isBusy || !readyFiles.length}
                checked={
                  readyFiles.length > 0 &&
                  readyFiles.every((file) => selected.includes(file.token))
                }
                onChange={(e) =>
                  setSelected(
                    e.target.checked ? readyFiles.map((file) => file.token) : []
                  )
                }
              />
              {intl.formatMessage(messages.selectAll)}
            </label>
            <p role="status" className="text-sm text-gray-400">
              {intl.formatMessage(messages.selectedCount, {
                selected: selected.length,
                total: candidates.length,
              })}
            </p>
          </div>
          {context.mediaType === 'tv' && bulkFiles.length > 1 && (
            <div className="space-y-2 rounded-md border border-gray-700 bg-gray-800 p-3">
              <label
                htmlFor="manual-import-bulk-start"
                className="mb-0 block text-sm font-semibold text-gray-200"
              >
                {intl.formatMessage(messages.numberFiles, {
                  count: bulkFiles.length,
                })}
              </label>
              <p className="text-xs text-gray-400">
                {intl.formatMessage(messages.numberFilesHint, { service })}
              </p>
              <div className="flex flex-wrap gap-2">
                <select
                  id="manual-import-bulk-start"
                  className="min-h-11 min-w-0 flex-1"
                  value={bulkStart}
                  disabled={isBusy}
                  onChange={(event) => setBulkStart(event.target.value)}
                >
                  <option value="">
                    {intl.formatMessage(messages.firstEpisode)}
                  </option>
                  {sortedEpisodes.map((episode) => (
                    <option key={episode.id} value={episode.id}>
                      {episodeCode(episode)} — {episode.title}
                    </option>
                  ))}
                </select>
                <Button
                  className="min-h-11"
                  disabled={
                    isBusy ||
                    !bulkEpisodes.length ||
                    bulkEpisodes.length !== bulkFiles.length
                  }
                  onClick={numberFiles}
                >
                  {intl.formatMessage(messages.assign)}
                </Button>
              </div>
              {bulkEpisodes.length > 0 && (
                <p role="status" className="text-xs text-gray-400">
                  {bulkEpisodes.length === bulkFiles.length
                    ? intl.formatMessage(messages.numberFilesPreview, {
                        first: episodeCode(bulkEpisodes[0]),
                        last: episodeCode(
                          bulkEpisodes[bulkEpisodes.length - 1]
                        ),
                        count: bulkFiles.length,
                      })
                    : intl.formatMessage(messages.numberFilesShort, {
                        count: bulkFiles.length,
                      })}
                </p>
              )}
            </div>
          )}
          {confirmOpen ? (
            // Escape dismisses this confirmation without closing its parent panel.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
            <div
              role="region"
              aria-label={intl.formatMessage(messages.confirmTitle, {
                mode,
                count: selectedFiles.length,
              })}
              className="space-y-3 rounded-md border border-gray-600 bg-gray-900/80 p-4 text-sm shadow"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  if (!submitting) dismissConfirmation();
                }
              }}
            >
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
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  buttonSize="sm"
                  className="min-h-11"
                  ref={confirmCancelRef}
                  disabled={submitting}
                  onClick={dismissConfirmation}
                >
                  {intl.formatMessage(messages.cancel)}
                </Button>
                <Button
                  type="button"
                  buttonType="success"
                  buttonSize="sm"
                  className="min-h-11"
                  disabled={
                    !selectedFiles.length ||
                    submitting ||
                    !selectedFiles.every(importable)
                  }
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
              className="min-h-11 w-full"
              ref={importTriggerRef}
              type="button"
              disabled={
                !selected.length ||
                submitting ||
                !selectedFiles.every(importable)
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
          {!confirmOpen && notReady.length > 0 && (
            <p className="text-xs text-yellow-300">
              {intl.formatMessage(
                notReady.some(
                  (candidate) =>
                    pendingRematch.has(candidate.token) ||
                    rematching.has(candidate.token)
                )
                  ? messages.waitingForRematch
                  : messages.notReady,
                { count: notReady.length, service }
              )}
            </p>
          )}
          <ul className="divide-y divide-gray-700 overflow-hidden rounded-md border border-gray-700 shadow">
            {candidates.map((candidate) => {
              const unsafeText =
                candidate.unsafe &&
                intl.formatMessage(rejectionMessages[candidate.unsafe], {
                  service,
                });
              const warnings = explain(candidate);
              const assigned = assignedTo(candidate);
              const checkboxId = `manual-import-${candidate.token}`;
              return (
                <li key={candidate.token} className="px-4 py-3 text-sm">
                  <div className="flex items-start gap-3">
                    <input
                      id={checkboxId}
                      type="checkbox"
                      className="mt-0.5 flex-none"
                      disabled={!!candidate.unsafe || submitting}
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
                      className="mb-0 min-h-11 min-w-0 flex-1 cursor-pointer font-normal"
                    >
                      <span className="block break-all font-medium text-white">
                        {candidate.name}
                      </span>
                      <span className="block break-words text-xs text-gray-400">
                        {[
                          formatSize(candidate.size),
                          candidate.quality ??
                            intl.formatMessage(messages.unknownQuality),
                          candidate.source,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      <span className="block break-words text-xs text-gray-400">
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
                  <div className="mt-2 space-y-2 sm:ml-9">
                    {!candidate.unsafe &&
                      stillMissing(candidate).length > 0 &&
                      !rematching.has(candidate.token) &&
                      !pendingRematch.has(candidate.token) && (
                        <p className="mt-1 text-xs text-yellow-300">
                          {intl.formatMessage(
                            stillMissing(candidate).every((field) =>
                              ['quality', 'languages'].includes(field)
                            )
                              ? messages.chooseDetails
                              : context.mediaType === 'tv' && !assigned.length
                                ? messages.pickEpisodes
                                : messages.incomplete,
                            { service }
                          )}
                        </p>
                      )}
                    {!candidate.unsafe &&
                      candidate.missing?.some((field) =>
                        ['quality', 'languages'].includes(field)
                      ) && (
                        <div className="grid gap-2 sm:grid-cols-2">
                          {candidate.missing.includes('quality') && (
                            <div>
                              <label
                                htmlFor={`${checkboxId}-quality`}
                                className="text-xs text-gray-400"
                              >
                                {intl.formatMessage(messages.quality)}
                              </label>
                              <select
                                id={`${checkboxId}-quality`}
                                className="min-h-11 w-full"
                                disabled={isBusy || !options}
                                value={
                                  overrides[candidate.token]?.qualityId ?? ''
                                }
                                onChange={(event) =>
                                  chooseDetail(candidate, {
                                    qualityId: event.target.value
                                      ? Number(event.target.value)
                                      : undefined,
                                  })
                                }
                              >
                                <option value="">
                                  {intl.formatMessage(messages.chooseQuality)}
                                </option>
                                {options?.qualities.map((quality) => (
                                  <option key={quality.id} value={quality.id}>
                                    {quality.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}
                          {candidate.missing.includes('languages') && (
                            <div>
                              <label
                                htmlFor={`${checkboxId}-language`}
                                className="text-xs text-gray-400"
                              >
                                {intl.formatMessage(messages.language)}
                              </label>
                              <select
                                id={`${checkboxId}-language`}
                                className="min-h-11 w-full"
                                disabled={isBusy || !options}
                                value={
                                  overrides[candidate.token]
                                    ?.languageIds?.[0] ?? ''
                                }
                                onChange={(event) =>
                                  chooseDetail(candidate, {
                                    languageIds: event.target.value
                                      ? [Number(event.target.value)]
                                      : undefined,
                                  })
                                }
                              >
                                <option value="">
                                  {intl.formatMessage(messages.chooseLanguage)}
                                </option>
                                {options?.languages.map((language) => (
                                  <option key={language.id} value={language.id}>
                                    {language.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}
                        </div>
                      )}
                    {unsafeText ? (
                      <p className="mt-1 text-xs font-semibold text-red-400">
                        {unsafeText}
                        {warnings
                          .filter((warning) => warning.text === unsafeText)
                          .map((warning, index) => (
                            <span
                              key={`${index}-${warning.detail}`}
                              className="block font-normal text-gray-400"
                            >
                              {warning.detail}
                            </span>
                          ))}
                      </p>
                    ) : (
                      candidate.multiSeason && (
                        <p className="mt-1 text-xs text-indigo-200">
                          {intl.formatMessage(messages.multiSeasonHint, {
                            service,
                          })}
                        </p>
                      )
                    )}
                    {warnings.some(
                      (warning) => warning.text !== unsafeText
                    ) && (
                      <ul className="mt-1 space-y-0.5 text-xs text-yellow-300">
                        {warnings
                          .filter((warning) => warning.text !== unsafeText)
                          .map((rejection, index) => (
                            <li key={`${index}-${rejection.text}`}>
                              {rejection.text}
                              {rejection.detail && (
                                <span className="block text-gray-400">
                                  {rejection.detail}
                                </span>
                              )}
                            </li>
                          ))}
                      </ul>
                    )}
                    {context.mediaType === 'tv' && !candidate.unsafe && (
                      <div className="mt-2 rounded-md border border-gray-700 bg-gray-800 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-gray-200">
                              {intl.formatMessage(messages.episodeAssignment)}
                            </div>
                            <p className="break-words text-xs text-gray-400">
                              {rematching.has(candidate.token)
                                ? intl.formatMessage(messages.rematching, {
                                    service,
                                  })
                                : describeEpisodes(assigned)}
                            </p>
                          </div>
                          {!needsEpisodes(candidate) && (
                            <Button
                              buttonSize="sm"
                              className="min-h-11"
                              aria-expanded={expanded.has(candidate.token)}
                              onClick={() =>
                                setExpanded((current) => {
                                  const next = new Set(current);
                                  if (!next.delete(candidate.token))
                                    next.add(candidate.token);
                                  return next;
                                })
                              }
                            >
                              {intl.formatMessage(
                                expanded.has(candidate.token)
                                  ? messages.doneEpisodes
                                  : messages.changeEpisodes
                              )}
                            </Button>
                          )}
                        </div>
                        {(expanded.has(candidate.token) ||
                          needsEpisodes(candidate)) && (
                          <div className="mt-3">
                            <EpisodeAssignmentPicker
                              episodes={episodes}
                              assigned={assigned}
                              initialSeason={candidate.seasonNumber}
                              disabled={
                                isBusy || rematching.has(candidate.token)
                              }
                              onChange={(ids) => assignEpisodes(candidate, ids)}
                            />
                            {unconfirmedMultiSeason(candidate) &&
                              assigned.length > 0 && (
                                <Button
                                  buttonSize="sm"
                                  className="mt-3 min-h-11 w-full"
                                  disabled={isBusy}
                                  onClick={() =>
                                    assignEpisodes(candidate, assigned)
                                  }
                                >
                                  {intl.formatMessage(
                                    messages.confirmEpisodes,
                                    { count: assigned.length }
                                  )}
                                </Button>
                              )}
                          </div>
                        )}
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
