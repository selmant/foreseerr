import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import Table from '@app/components/Common/Table';
import FixMappingModal from '@app/components/TitleCard/FixMappingModal';
import useToasts from '@app/hooks/useToasts';
import { formatBytes } from '@app/utils/numberHelpers';
import axios from 'axios';
import { useState } from 'react';
import useSWR from 'swr';

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

const Stat = ({ label, value }: { label: string; value: string | number }) => (
  <div className="rounded-md bg-gray-800 p-4 ring-1 ring-gray-700">
    <div className="text-xs uppercase tracking-wider text-gray-400">
      {label}
    </div>
    <div className="mt-1 text-2xl font-semibold text-white">{value}</div>
  </div>
);

const phaseLabel = (phase: RefreshProgress['phase']): string => {
  if (phase === 'downloading') return 'Downloading';
  if (phase === 'validating') return 'Validating';
  if (phase === 'parsing') return 'Parsing';
  return 'Writing';
};

const RefreshBar = ({ progress }: { progress?: RefreshProgress }) => {
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
      : 'in progress';

  return (
    <div className="mt-2 w-56">
      <div className="flex justify-between text-xs text-gray-400">
        <span>{phaseLabel(phase)}</span>
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

const ORIGIN_LABEL: Record<string, string> = {
  title: 'exact title match',
  prequel: "prequel's show",
};

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
  const { addToast } = useToasts();
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
          ? `${key}: ${data.error ?? 'refresh failed'}`
          : `${key}: ${data.status}${data.edges ? ` (${data.edges.toLocaleString()} edges)` : ''}`,
        {
          appearance: data.status === 'failed' ? 'error' : 'success',
          autoDismiss: true,
        }
      );
    } catch {
      addToast(`Unable to refresh ${key}.`, {
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
      addToast(`Unable to update ${dataset.key}.`, {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const forget = async (row: ResolutionRow) => {
    try {
      await axios.delete(`/api/v1/settings/mapping/resolutions/${row.id}`);
      revalidateAll();
    } catch {
      addToast('Unable to remove the mapping.', {
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
        `Imported ${data.imported} correction(s), skipped ${data.skipped}.`,
        { appearance: 'success', autoDismiss: true }
      );
      revalidateAll();
    } catch {
      addToast('Unable to import corrections.', {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const datasets = status?.datasets ?? [];
  const nothingLoaded = !datasets.some(
    (dataset) => dataset.enabled && dataset.edgeCount
  );

  return (
    <>
      <PageTitle title="Mapping" />
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

      {nothingLoaded && (
        <Alert title="No mapping dataset is loaded yet">
          Foreseerr matches anime from AniList and Simkl to TMDB with these
          datasets. They download on their own; until one has finished, anime is
          matched by title only and more of it stays unmapped.
        </Alert>
      )}

      <div className="mb-6">
        <h3 className="heading">Mapping</h3>
        <p className="description">
          How items from AniList, Simkl, Trakt and MDBList are matched to TMDB.
          A match comes from, in order: your corrections, the datasets, TMDB's
          own index of IMDb and TVDB ids, and for anime nothing else knows yet,
          an exact title match or the show of its prequel.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Stat label="Unmapped" value={status?.counts.unmapped ?? 0} />
        <Stat label="Guessed" value={status?.counts.guessed ?? 0} />
        <Stat label="Corrections" value={status?.counts.manual ?? 0} />
      </div>

      <div className="mt-8">
        <h3 className="heading">Datasets</h3>
        <p className="description">
          Downloaded nightly and stored locally. A later dataset only fills ids
          an earlier one does not have.
        </p>
        <Table>
          <thead>
            <tr>
              <Table.TH>Dataset</Table.TH>
              <Table.TH>Edges</Table.TH>
              <Table.TH>Updated</Table.TH>
              <Table.TH>Licence</Table.TH>
              <Table.TH className="text-right">Actions</Table.TH>
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
                    {dataset.edgeCount?.toLocaleString() ?? '—'}
                  </Table.TD>
                  <Table.TD>
                    {dataset.lastSuccessAt
                      ? new Date(dataset.lastSuccessAt).toLocaleString()
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
                          {refreshing ? 'Refreshing…' : 'Refresh'}
                        </Button>
                      )}
                      <Button
                        buttonType={dataset.enabled ? 'danger' : 'default'}
                        buttonSize="sm"
                        disabled={refreshing}
                        onClick={() => toggleDataset(dataset)}
                      >
                        {dataset.enabled ? 'Disable' : 'Enable'}
                      </Button>
                    </div>
                  </Table.TD>
                </tr>
              );
            })}
          </Table.TBody>
        </Table>
      </div>

      <div className="mt-8">
        <h3 className="heading">Unmapped</h3>
        <p className="description">
          Items no step could match, most-seen first. Each is retried on its
          own; fix one here if you know its TMDB entry.
        </p>
        <Table>
          <thead>
            <tr>
              <Table.TH>Item</Table.TH>
              <Table.TH>Seen in</Table.TH>
              <Table.TH>Seen</Table.TH>
              <Table.TH className="text-right">Actions</Table.TH>
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
                <Table.TD>{row.hitCount}</Table.TD>
                <Table.TD alignText="right">
                  <div className="flex justify-end gap-2">
                    <Button
                      buttonType="primary"
                      buttonSize="sm"
                      onClick={() => setFixing(row)}
                    >
                      Fix
                    </Button>
                    <Button
                      buttonType="default"
                      buttonSize="sm"
                      onClick={() => forget(row)}
                    >
                      Dismiss
                    </Button>
                  </div>
                </Table.TD>
              </tr>
            ))}
            {!unmapped?.results.length && (
              <EmptyRow columns={4} text="Nothing is unmapped." />
            )}
          </Table.TBody>
        </Table>
      </div>

      <div className="mt-8">
        <h3 className="heading">Guessed</h3>
        <p className="description">
          Anime matched by the fallback because no dataset knows it yet. These
          show as normal tiles and are replaced once a dataset catches up.
          Correct one that is wrong, or discard it to have it worked out again.
        </p>
        <Table>
          <thead>
            <tr>
              <Table.TH>Item</Table.TH>
              <Table.TH>Matched to</Table.TH>
              <Table.TH>How</Table.TH>
              <Table.TH className="text-right">Actions</Table.TH>
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
                    TMDB {row.tmdbType} {row.tmdbId}
                  </a>
                </Table.TD>
                <Table.TD>
                  <div>{ORIGIN_LABEL[row.origin] ?? row.origin}</div>
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
                      Correct
                    </Button>
                    <Button
                      buttonType="default"
                      buttonSize="sm"
                      onClick={() => forget(row)}
                    >
                      Discard
                    </Button>
                  </div>
                </Table.TD>
              </tr>
            ))}
            {!guessed?.results.length && (
              <EmptyRow columns={4} text="No guessed matches." />
            )}
          </Table.TBody>
        </Table>
      </div>

      <div className="mt-8">
        <div className="flex items-end justify-between">
          <div>
            <h3 className="heading">Corrections</h3>
            <p className="description">
              Your own matches. They win over everything else and nothing
              changes them but you.
            </p>
          </div>
          <div className="flex gap-2">
            <Button buttonType="default" onClick={exportCorrections}>
              Export
            </Button>
            <label className="inline-flex cursor-pointer items-center rounded-md border border-gray-500 px-4 py-2 text-sm text-white">
              Import
              <input
                type="file"
                accept="application/json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) importCorrections(file);
                  event.target.value = '';
                }}
              />
            </label>
          </div>
        </div>
        <Table>
          <thead>
            <tr>
              <Table.TH>Item</Table.TH>
              <Table.TH>Matched to</Table.TH>
              <Table.TH>Note</Table.TH>
              <Table.TH className="text-right">Actions</Table.TH>
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
                      TMDB {row.tmdbType} {row.tmdbId}
                    </a>
                  ) : (
                    <span className="text-gray-400">No TMDB entry</span>
                  )}
                </Table.TD>
                <Table.TD>{row.detail ?? '—'}</Table.TD>
                <Table.TD alignText="right">
                  <Button
                    buttonType="danger"
                    buttonSize="sm"
                    onClick={() => forget(row)}
                  >
                    Remove
                  </Button>
                </Table.TD>
              </tr>
            ))}
            {!manual?.results.length && (
              <EmptyRow columns={4} text="No corrections." />
            )}
          </Table.TBody>
        </Table>
      </div>
    </>
  );
};

export default SettingsMapping;
