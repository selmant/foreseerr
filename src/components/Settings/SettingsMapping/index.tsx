import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import Table from '@app/components/Common/Table';
import FixMappingModal from '@app/components/TitleCard/FixMappingModal';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { formatBytes } from '@app/utils/numberHelpers';
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  ArrowUpTrayIcon,
} from '@heroicons/react/24/outline';
import axios from 'axios';
import { useRef, useState } from 'react';
import { useIntl, type IntlShape } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Settings.SettingsMapping', {
  mapping: 'Mapping',
  mappingDescription:
    'How items from AniList, Simkl, Trakt and MDBList are matched to TMDB. A match comes from, in order: your corrections, the datasets, TMDB’s own index of IMDb and TVDB ids, and for anime nothing else knows yet, an exact title match or the show of its prequel.',
  noDatasetTitle: 'No mapping dataset is loaded yet',
  noDatasetDescription:
    'Foreseerr matches anime from AniList and Simkl to TMDB with these datasets. They download on their own; until one has finished, anime is matched by title only and more of it stays unmapped.',
  unmapped: 'Unmapped',
  guessed: 'Guessed',
  corrections: 'Corrections',
  datasets: 'Datasets',
  datasetsDescription:
    'Downloaded nightly and stored locally. A later dataset only fills ids an earlier one does not have.',
  dataset: 'Dataset',
  edges: 'Edges',
  updated: 'Updated',
  licence: 'Licence',
  actions: 'Actions',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  enable: 'Enable',
  disable: 'Disable',
  phaseDownloading: 'Downloading',
  phaseValidating: 'Validating',
  phaseParsing: 'Parsing',
  phaseWriting: 'Writing',
  inProgress: 'in progress',
  refreshFailed: '{dataset}: {error}',
  refreshFailedGeneric: 'refresh failed',
  refreshDone:
    '{dataset}: {status}{edges, select, none {} other { ({edges} edges)}}',
  refreshError: 'Unable to refresh {dataset}.',
  toggleError: 'Unable to update {dataset}.',
  unmappedDescription:
    'Items no step could match, most-seen first. Each is retried on its own; fix one here if you know its TMDB entry.',
  item: 'Item',
  seenIn: 'Seen In',
  seen: 'Seen',
  fix: 'Fix',
  dismiss: 'Dismiss',
  nothingUnmapped: 'Nothing is unmapped.',
  guessedDescription:
    'Anime matched by the fallback because no dataset knows it yet. These show as normal tiles and are replaced once a dataset catches up. Correct one that is wrong, or discard it to have it worked out again.',
  matchedTo: 'Matched To',
  how: 'How',
  correct: 'Correct',
  discard: 'Discard',
  noGuessed: 'No guessed matches.',
  originTitle: 'Exact title match',
  originPrequel: 'Prequel’s show',
  correctionsDescription:
    'Your own matches. They win over everything else and nothing changes them but you.',
  export: 'Export',
  import: 'Import',
  note: 'Note',
  noTmdbEntry: 'No TMDB entry',
  remove: 'Remove',
  noCorrections: 'No corrections.',
  tmdbEntry: 'TMDB {mediaType} {tmdbId}',
  removeError: 'Unable to remove the mapping.',
  imported:
    'Imported {imported, plural, one {# correction} other {# corrections}}, skipped {skipped}.',
  importError: 'Unable to import corrections.',
});

interface ResolutionRow {
  id: number;
  srcNs: string;
  srcId: string;
  mediaType: '' | 'movie' | 'tv';
  tmdbId?: number | null;
  tmdbType?: 'movie' | 'tv' | null;
  origin: 'manual' | 'tmdb-find' | 'title' | 'prequel' | 'miss';
  title?: string | null;
  discoverSource?: string | null;
  detail?: string | null;
  hitCount: number;
  updatedAt: string;
}

interface RefreshProgress {
  key: string;
  phase: 'downloading' | 'validating' | 'parsing' | 'ingesting';
  bytesReceived?: number;
  bytesTotal?: number;
  recordsDone?: number;
  recordsTotal?: number;
}

interface DatasetRow {
  key: string;
  enabled: boolean;
  licence: string;
  note?: string;
  edgeCount?: number | null;
  version?: string | null;
  lastSuccessAt?: string | null;
  lastError?: string | null;
  refresh?: RefreshProgress;
}

interface StatusResponse {
  datasets: DatasetRow[];
  counts: { unmapped: number; manual: number; guessed: number };
}

type ResolutionList = { results: ResolutionRow[]; total: number };

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded-lg bg-gray-800 p-4 shadow ring-1 ring-gray-700">
    <div className="text-sm font-medium text-gray-400">{label}</div>
    <div className="mt-1 text-2xl font-semibold text-white">{value}</div>
  </div>
);

const phaseLabel = (phase: RefreshProgress['phase'], intl: IntlShape): string =>
  intl.formatMessage(
    phase === 'downloading'
      ? messages.phaseDownloading
      : phase === 'validating'
        ? messages.phaseValidating
        : phase === 'parsing'
          ? messages.phaseParsing
          : messages.phaseWriting
  );

const RefreshBar = ({ progress }: { progress?: RefreshProgress }) => {
  const intl = useIntl();
  const phase = progress?.phase ?? 'downloading';
  const percent =
    phase === 'ingesting' && progress?.recordsTotal
      ? Math.min(
          100,
          Math.round(
            (100 * (progress.recordsDone ?? 0)) / progress.recordsTotal
          )
        )
      : progress?.bytesTotal
        ? Math.min(
            100,
            Math.round(
              (100 * (progress.bytesReceived ?? 0)) / progress.bytesTotal
            )
          )
        : undefined;
  const detail =
    phase === 'downloading' && progress?.bytesReceived != null
      ? formatBytes(progress.bytesReceived, 1)
      : intl.formatMessage(messages.inProgress);

  return (
    <div className="mt-2 w-56">
      <div className="flex justify-between text-xs text-gray-400">
        <span>{phaseLabel(phase, intl)}</span>
        <span>{percent != null ? `${percent}%` : detail}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded bg-gray-700">
        <div
          className={`h-full bg-indigo-500 ${
            percent == null ? 'w-full animate-pulse' : 'transition-all'
          }`}
          style={percent != null ? { width: `${percent}%` } : undefined}
        />
      </div>
    </div>
  );
};

const originLabel = (origin: ResolutionRow['origin'], intl: IntlShape) =>
  origin === 'title'
    ? intl.formatMessage(messages.originTitle)
    : origin === 'prequel'
      ? intl.formatMessage(messages.originPrequel)
      : origin;

const tmdbUrl = (row: ResolutionRow): string =>
  `https://www.themoviedb.org/${row.tmdbType}/${row.tmdbId}`;

const sourceId = (row: ResolutionRow): string => `${row.srcNs}:${row.srcId}`;

const EmptyRow = ({ columns, text }: { columns: number; text: string }) => (
  <tr>
    <Table.TD colSpan={columns}>
      <div className="py-6 text-center text-gray-400">{text}</div>
    </Table.TD>
  </tr>
);

const SettingsMapping = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const importInputRef = useRef<HTMLInputElement>(null);
  const [fixing, setFixing] = useState<ResolutionRow | null>(null);
  const [refreshingKeys, setRefreshingKeys] = useState<string[]>([]);

  const {
    data: status,
    error,
    mutate: revalidateStatus,
  } = useSWR<StatusResponse>('/api/v1/settings/mapping/status', {
    refreshInterval: (data) =>
      data?.datasets.some((dataset) => dataset.refresh) ||
      refreshingKeys.length > 0
        ? 1000
        : 30000,
  });
  const { data: unmapped, mutate: revalidateUnmapped } = useSWR<ResolutionList>(
    '/api/v1/settings/mapping/resolutions?list=unmapped&take=50'
  );
  const { data: guessed, mutate: revalidateGuessed } = useSWR<ResolutionList>(
    '/api/v1/settings/mapping/resolutions?list=guessed&take=50'
  );
  const { data: manual, mutate: revalidateManual } = useSWR<ResolutionList>(
    '/api/v1/settings/mapping/resolutions?list=manual&take=200'
  );

  if (!status && !error) return <LoadingSpinner />;

  const revalidateAll = () => {
    void revalidateStatus();
    void revalidateUnmapped();
    void revalidateGuessed();
    void revalidateManual();
  };

  const refreshDataset = async (key: string) => {
    setRefreshingKeys((keys) => (keys.includes(key) ? keys : [...keys, key]));
    void revalidateStatus();
    try {
      const { data } = await axios.post(
        `/api/v1/settings/mapping/datasets/${key}/refresh`
      );
      addToast(
        data.status === 'failed'
          ? intl.formatMessage(messages.refreshFailed, {
              dataset: key,
              error:
                data.error ?? intl.formatMessage(messages.refreshFailedGeneric),
            })
          : intl.formatMessage(messages.refreshDone, {
              dataset: key,
              status: data.status,
              edges: data.edges ? intl.formatNumber(data.edges) : 'none',
            }),
        {
          appearance: data.status === 'failed' ? 'error' : 'success',
          autoDismiss: true,
        }
      );
    } catch {
      addToast(intl.formatMessage(messages.refreshError, { dataset: key }), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setRefreshingKeys((keys) => keys.filter((item) => item !== key));
      revalidateAll();
    }
  };

  const toggleDataset = async (dataset: DatasetRow) => {
    try {
      await axios.post(`/api/v1/settings/mapping/datasets/${dataset.key}`, {
        enabled: !dataset.enabled,
      });
      void revalidateStatus();
    } catch {
      addToast(
        intl.formatMessage(messages.toggleError, { dataset: dataset.key }),
        {
          appearance: 'error',
          autoDismiss: true,
        }
      );
    }
  };

  const forget = async (row: ResolutionRow) => {
    try {
      await axios.delete(`/api/v1/settings/mapping/resolutions/${row.id}`);
      revalidateAll();
    } catch {
      addToast(intl.formatMessage(messages.removeError), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const exportCorrections = async () => {
    const { data } = await axios.get<ResolutionList>(
      '/api/v1/settings/mapping/resolutions?list=manual&take=1000'
    );
    const blob = new Blob([JSON.stringify(data.results, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'mapping-corrections.json';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importCorrections = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text());
      const corrections = Array.isArray(parsed) ? parsed : parsed.results;
      const { data } = await axios.post(
        '/api/v1/settings/mapping/corrections/import',
        { corrections }
      );
      addToast(
        intl.formatMessage(messages.imported, {
          imported: data.imported,
          skipped: data.skipped,
        }),
        { appearance: 'success', autoDismiss: true }
      );
      revalidateAll();
    } catch {
      addToast(intl.formatMessage(messages.importError), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const datasets = status?.datasets ?? [];
  const nothingLoaded = !datasets.some(
    (dataset) => dataset.enabled && dataset.edgeCount
  );

  const dateTime = (value: string) =>
    intl.formatDate(value, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  const tmdbEntry = (row: ResolutionRow) =>
    intl.formatMessage(messages.tmdbEntry, {
      mediaType: row.tmdbType,
      tmdbId: row.tmdbId,
    });

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.mapping),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      {fixing && (
        <FixMappingModal
          title={fixing.title ?? sourceId(fixing)}
          mediaType={fixing.tmdbType ?? (fixing.mediaType || undefined)}
          namespace={fixing.srcNs}
          externalId={fixing.srcId}
          tmdbId={fixing.tmdbId}
          onClose={() => setFixing(null)}
          onSaved={revalidateAll}
        />
      )}

      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.mapping)}</h3>
        <p className="description">
          {intl.formatMessage(messages.mappingDescription)}
        </p>
      </div>
      <div className="section">
        {nothingLoaded && (
          <Alert title={intl.formatMessage(messages.noDatasetTitle)}>
            {intl.formatMessage(messages.noDatasetDescription)}
          </Alert>
        )}
        <div className="grid max-w-6xl grid-cols-1 gap-4 sm:grid-cols-3">
          <Stat
            label={intl.formatMessage(messages.unmapped)}
            value={intl.formatNumber(status?.counts.unmapped ?? 0)}
          />
          <Stat
            label={intl.formatMessage(messages.guessed)}
            value={intl.formatNumber(status?.counts.guessed ?? 0)}
          />
          <Stat
            label={intl.formatMessage(messages.corrections)}
            value={intl.formatNumber(status?.counts.manual ?? 0)}
          />
        </div>
      </div>

      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.datasets)}</h3>
        <p className="description">
          {intl.formatMessage(messages.datasetsDescription)}
        </p>
      </div>
      <div className="section">
        <Table>
          <thead>
            <tr>
              <Table.TH>{intl.formatMessage(messages.dataset)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.edges)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.updated)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.licence)}</Table.TH>
              <Table.TH className="text-right">
                {intl.formatMessage(messages.actions)}
              </Table.TH>
            </tr>
          </thead>
          <Table.TBody>
            {datasets.map((dataset) => {
              const refreshing =
                Boolean(dataset.refresh) ||
                refreshingKeys.includes(dataset.key);
              return (
                <tr key={dataset.key}>
                  <Table.TD>
                    <div className="font-medium text-white">{dataset.key}</div>
                    {dataset.version && (
                      <div className="text-xs text-gray-400">
                        {dataset.version}
                      </div>
                    )}
                    {dataset.lastError && (
                      <div className="mt-1 text-xs text-red-400">
                        {dataset.lastError}
                      </div>
                    )}
                    {refreshing && <RefreshBar progress={dataset.refresh} />}
                  </Table.TD>
                  <Table.TD>
                    {dataset.edgeCount != null
                      ? intl.formatNumber(dataset.edgeCount)
                      : '—'}
                  </Table.TD>
                  <Table.TD>
                    {dataset.lastSuccessAt
                      ? dateTime(dataset.lastSuccessAt)
                      : '—'}
                  </Table.TD>
                  <Table.TD>
                    <div className="text-xs text-gray-300">
                      {dataset.licence}
                    </div>
                    {dataset.note && (
                      <div className="max-w-xs whitespace-normal text-xs text-yellow-500">
                        {dataset.note}
                      </div>
                    )}
                  </Table.TD>
                  <Table.TD alignText="right">
                    <div className="flex justify-end gap-2">
                      {dataset.enabled && (
                        <Button
                          buttonType="primary"
                          buttonSize="sm"
                          disabled={refreshing}
                          onClick={() => refreshDataset(dataset.key)}
                        >
                          <ArrowPathIcon
                            className={refreshing ? 'animate-spin' : ''}
                          />
                          <span>
                            {intl.formatMessage(
                              refreshing
                                ? messages.refreshing
                                : messages.refresh
                            )}
                          </span>
                        </Button>
                      )}
                      <Button
                        buttonType={dataset.enabled ? 'danger' : 'default'}
                        buttonSize="sm"
                        disabled={refreshing}
                        onClick={() => toggleDataset(dataset)}
                      >
                        {intl.formatMessage(
                          dataset.enabled ? messages.disable : messages.enable
                        )}
                      </Button>
                    </div>
                  </Table.TD>
                </tr>
              );
            })}
          </Table.TBody>
        </Table>
      </div>

      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.unmapped)}</h3>
        <p className="description">
          {intl.formatMessage(messages.unmappedDescription)}
        </p>
      </div>
      <div className="section">
        <Table>
          <thead>
            <tr>
              <Table.TH>{intl.formatMessage(messages.item)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.seenIn)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.seen)}</Table.TH>
              <Table.TH className="text-right">
                {intl.formatMessage(messages.actions)}
              </Table.TH>
            </tr>
          </thead>
          <Table.TBody>
            {(unmapped?.results ?? []).map((row) => (
              <tr key={row.id}>
                <Table.TD>
                  <div className="font-medium text-white">
                    {row.title ?? sourceId(row)}
                  </div>
                  <div className="text-xs text-gray-400">
                    {sourceId(row)}
                    {row.mediaType ? ` · ${row.mediaType}` : ''}
                    {row.detail ? ` · ${row.detail}` : ''}
                  </div>
                </Table.TD>
                <Table.TD>{row.discoverSource ?? '—'}</Table.TD>
                <Table.TD>{intl.formatNumber(row.hitCount)}</Table.TD>
                <Table.TD alignText="right">
                  <div className="flex justify-end gap-2">
                    <Button
                      buttonType="primary"
                      buttonSize="sm"
                      onClick={() => setFixing(row)}
                    >
                      {intl.formatMessage(messages.fix)}
                    </Button>
                    <Button
                      buttonType="default"
                      buttonSize="sm"
                      onClick={() => forget(row)}
                    >
                      {intl.formatMessage(messages.dismiss)}
                    </Button>
                  </div>
                </Table.TD>
              </tr>
            ))}
            {!unmapped?.results.length && (
              <EmptyRow
                columns={4}
                text={intl.formatMessage(messages.nothingUnmapped)}
              />
            )}
          </Table.TBody>
        </Table>
      </div>

      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.guessed)}</h3>
        <p className="description">
          {intl.formatMessage(messages.guessedDescription)}
        </p>
      </div>
      <div className="section">
        <Table>
          <thead>
            <tr>
              <Table.TH>{intl.formatMessage(messages.item)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.matchedTo)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.how)}</Table.TH>
              <Table.TH className="text-right">
                {intl.formatMessage(messages.actions)}
              </Table.TH>
            </tr>
          </thead>
          <Table.TBody>
            {(guessed?.results ?? []).map((row) => (
              <tr key={row.id}>
                <Table.TD>
                  <div className="font-medium text-white">
                    {row.title ?? sourceId(row)}
                  </div>
                  <div className="text-xs text-gray-400">{sourceId(row)}</div>
                </Table.TD>
                <Table.TD>
                  <a
                    href={tmdbUrl(row)}
                    target="_blank"
                    rel="noreferrer"
                    className="text-indigo-400 hover:underline"
                  >
                    {tmdbEntry(row)}
                  </a>
                </Table.TD>
                <Table.TD>
                  <div>{originLabel(row.origin, intl)}</div>
                  {row.detail && (
                    <div className="text-xs text-gray-400">{row.detail}</div>
                  )}
                </Table.TD>
                <Table.TD alignText="right">
                  <div className="flex justify-end gap-2">
                    <Button
                      buttonType="primary"
                      buttonSize="sm"
                      onClick={() => setFixing(row)}
                    >
                      {intl.formatMessage(messages.correct)}
                    </Button>
                    <Button
                      buttonType="default"
                      buttonSize="sm"
                      onClick={() => forget(row)}
                    >
                      {intl.formatMessage(messages.discard)}
                    </Button>
                  </div>
                </Table.TD>
              </tr>
            ))}
            {!guessed?.results.length && (
              <EmptyRow
                columns={4}
                text={intl.formatMessage(messages.noGuessed)}
              />
            )}
          </Table.TBody>
        </Table>
      </div>

      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <h3 className="heading">
            {intl.formatMessage(messages.corrections)}
          </h3>
          <p className="description">
            {intl.formatMessage(messages.correctionsDescription)}
          </p>
        </div>
        <div className="flex gap-2">
          <Button buttonType="default" onClick={exportCorrections}>
            <ArrowDownTrayIcon />
            <span>{intl.formatMessage(messages.export)}</span>
          </Button>
          <Button
            buttonType="default"
            onClick={() => importInputRef.current?.click()}
          >
            <ArrowUpTrayIcon />
            <span>{intl.formatMessage(messages.import)}</span>
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json"
            className="hidden"
            aria-label={intl.formatMessage(messages.import)}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) importCorrections(file);
              event.target.value = '';
            }}
          />
        </div>
      </div>
      <div className="section">
        <Table>
          <thead>
            <tr>
              <Table.TH>{intl.formatMessage(messages.item)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.matchedTo)}</Table.TH>
              <Table.TH>{intl.formatMessage(messages.note)}</Table.TH>
              <Table.TH className="text-right">
                {intl.formatMessage(messages.actions)}
              </Table.TH>
            </tr>
          </thead>
          <Table.TBody>
            {(manual?.results ?? []).map((row) => (
              <tr key={row.id}>
                <Table.TD>
                  <div className="font-medium text-white">
                    {row.title ?? sourceId(row)}
                  </div>
                  {row.title && (
                    <div className="text-xs text-gray-400">{sourceId(row)}</div>
                  )}
                </Table.TD>
                <Table.TD>
                  {row.tmdbId ? (
                    <a
                      href={tmdbUrl(row)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-indigo-400 hover:underline"
                    >
                      {tmdbEntry(row)}
                    </a>
                  ) : (
                    <span className="text-gray-400">
                      {intl.formatMessage(messages.noTmdbEntry)}
                    </span>
                  )}
                </Table.TD>
                <Table.TD>{row.detail ?? '—'}</Table.TD>
                <Table.TD alignText="right">
                  <Button
                    buttonType="danger"
                    buttonSize="sm"
                    onClick={() => forget(row)}
                  >
                    {intl.formatMessage(messages.remove)}
                  </Button>
                </Table.TD>
              </tr>
            ))}
            {!manual?.results.length && (
              <EmptyRow
                columns={4}
                text={intl.formatMessage(messages.noCorrections)}
              />
            )}
          </Table.TBody>
        </Table>
      </div>
    </>
  );
};

export default SettingsMapping;
