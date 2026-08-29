import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import Table from '@app/components/Common/Table';
import MappingRepairModal from '@app/components/Settings/SettingsMapping/MappingRepairModal';
import useToasts from '@app/hooks/useToasts';
import { formatBytes } from '@app/utils/numberHelpers';
import axios from 'axios';
import { useState } from 'react';
import useSWR from 'swr';

export interface MappingGapRow {
  id: number;
  namespace: string;
  externalId: string;
  season: number;
  title?: string;
  year?: number;
  mediaType?: 'movie' | 'tv';
  discoverSource?: string;
  reason: string;
  rejectedTarget?: string;
  sourceKey?: string;
  suggestedTarget?: string;
  suggestedConfidence?: number;
  suggestedBy?: string;
  hitCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface BudgetSnapshot {
  key: string;
  costClass: string;
  tokens: number;
  inFlight: number;
  queued: number;
  circuitState: 'closed' | 'open' | 'half-open';
  consecutiveFailures: number;
  requestsToday: number;
  dailyQuota?: number;
}

interface UsageRow {
  sourceKey: string;
  day: string;
  requests: number;
  failures: number;
  itemsResolved: number;
}

interface SourceRow {
  key: string;
  kind: string;
  enabled: boolean;
  priority: number;
  trust: number;
  format?: string;
  mirrors?: string[];
  licence?: string | null;
  legalNote?: string | null;
  version?: string | null;
  entryCount?: number | null;
  lastSuccessAt?: string | null;
  lastError?: string | null;
  circuitState?: string;
  costClass?: string;
  rps?: number | null;
  concurrency?: number | null;
  dailyQuota?: number | null;
}

interface HealthResponse {
  gaps: {
    openGaps: number;
    totalHits: number;
    byReason: Record<string, number>;
    bySource: Record<string, number>;
    byNamespace: Record<string, number>;
  };
  budgets: BudgetSnapshot[];
  usage: UsageRow[];
  sources: SourceRow[];
  resolvers: { key: string; kind: string; trust: number }[];
  providers?: ProviderHealthRow[];
  refreshes?: PackRefreshProgress[];
}

interface PackRefreshProgress {
  key: string;
  phase: 'downloading' | 'validating' | 'parsing' | 'ingesting';
  mirror?: string;
  bytesReceived?: number;
  bytesTotal?: number;
  recordsDone?: number;
  recordsTotal?: number;
  startedAt: string;
  updatedAt: string;
}

interface ProviderHealthRow {
  key: string;
  state: 'ok' | 'failing' | 'unconfigured';
  detail?: string;
  checkedAt: string;
}

const circuitStyle = (state?: string): string => {
  if (state === 'open') return 'bg-red-600 text-white';
  if (state === 'half-open') return 'bg-yellow-600 text-white';
  return 'bg-green-700 text-white';
};

const Stat = ({ label, value }: { label: string; value: string | number }) => (
  <div className="rounded-md bg-gray-800 p-4 ring-1 ring-gray-700">
    <div className="text-xs uppercase tracking-wider text-gray-400">
      {label}
    </div>
    <div className="mt-1 text-2xl font-semibold text-white">{value}</div>
  </div>
);

const phaseLabel = (phase: PackRefreshProgress['phase']): string => {
  if (phase === 'downloading') return 'Downloading';
  if (phase === 'validating') return 'Validating';
  if (phase === 'parsing') return 'Parsing';
  return 'Ingesting';
};

const PackProgress = ({ progress }: { progress: PackRefreshProgress }) => {
  const percent =
    progress.phase === 'ingesting' &&
    progress.recordsTotal &&
    progress.recordsTotal > 0
      ? Math.min(
          100,
          Math.round(
            (100 * (progress.recordsDone ?? 0)) / progress.recordsTotal
          )
        )
      : progress.bytesTotal && progress.bytesTotal > 0
        ? Math.min(
            100,
            Math.round(
              (100 * (progress.bytesReceived ?? 0)) / progress.bytesTotal
            )
          )
        : undefined;
  const detail =
    progress.phase === 'ingesting' && progress.recordsTotal
      ? `${(progress.recordsDone ?? 0).toLocaleString()} / ${progress.recordsTotal.toLocaleString()} records`
      : progress.bytesReceived != null
        ? `${formatBytes(progress.bytesReceived, 1)}${
            progress.bytesTotal
              ? ` / ${formatBytes(progress.bytesTotal, 1)}`
              : ''
          }`
        : null;

  return (
    <div className="mt-2 w-56">
      <div className="flex justify-between text-xs text-gray-400">
        <span>{phaseLabel(progress.phase)}</span>
        <span>
          {percent != null ? `${percent}%` : (detail ?? 'in progress')}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded bg-gray-700">
        <div
          className={`h-full bg-indigo-500 ${
            percent == null ? 'w-full animate-pulse' : 'transition-all'
          }`}
          style={percent != null ? { width: `${percent}%` } : undefined}
        />
      </div>
      {percent != null && detail && (
        <div className="mt-1 text-xs text-gray-500">{detail}</div>
      )}
    </div>
  );
};

const SettingsMapping = () => {
  const { addToast } = useToasts();
  const [repairing, setRepairing] = useState<MappingGapRow | null>(null);
  const [refreshingKeys, setRefreshingKeys] = useState<string[]>([]);

  const {
    data: health,
    error,
    mutate: revalidateHealth,
  } = useSWR<HealthResponse>('/api/v1/settings/mapping/health', {
    refreshInterval: (data) =>
      (data?.refreshes?.length ?? 0) > 0 || refreshingKeys.length > 0
        ? 1000
        : 30000,
  });
  const { data: gaps, mutate: revalidateGaps } = useSWR<{
    results: MappingGapRow[];
    total: number;
  }>('/api/v1/settings/mapping/gaps?take=50');

  if (!health && !error) return <LoadingSpinner />;

  const refreshByKey = new Map(
    (health?.refreshes ?? []).map((row) => [row.key, row])
  );

  const refreshPack = async (key: string) => {
    setRefreshingKeys((keys) => (keys.includes(key) ? keys : [...keys, key]));
    void revalidateHealth();
    try {
      const { data } = await axios.post(
        `/api/v1/settings/mapping/sources/${key}/refresh`
      );
      addToast(
        `${key}: ${data.status}${data.records ? ` (${data.records} records)` : ''}`,
        {
          appearance: data.status === 'failed' ? 'error' : 'success',
          autoDismiss: true,
        }
      );
      revalidateHealth();
    } catch {
      addToast(`Unable to refresh ${key}.`, {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setRefreshingKeys((keys) => keys.filter((item) => item !== key));
    }
  };

  /**
   * Title matching is quarantined: this only annotates the queue with guesses
   * for a human to accept, and never changes what the resolvers return.
   */
  const suggestMatches = async () => {
    try {
      const { data } = await axios.post(
        '/api/v1/settings/mapping/gaps/suggest',
        { limit: 50 }
      );
      addToast(
        `Suggested ${data.suggested} of ${data.examined} examined. Review each before accepting.`,
        { appearance: 'success', autoDismiss: true }
      );
      revalidateGaps();
    } catch {
      addToast('Unable to generate suggestions.', {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const toggleSource = async (source: SourceRow) => {
    try {
      await axios.post(`/api/v1/settings/mapping/sources/${source.key}`, {
        enabled: !source.enabled,
      });
      revalidateHealth();
    } catch {
      addToast(`Unable to update ${source.key}.`, {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const resetCircuit = async (key: string) => {
    try {
      await axios.post(`/api/v1/settings/mapping/sources/${key}/reset-circuit`);
      addToast(`Circuit breaker reset for ${key}.`, {
        appearance: 'success',
        autoDismiss: true,
      });
      revalidateHealth();
    } catch {
      addToast(`Unable to reset ${key}.`, {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const exportOverrides = async () => {
    const { data } = await axios.get('/api/v1/settings/mapping/overrides');
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'mapping-overrides.json';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importOverrides = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text());
      const overrides = Array.isArray(parsed) ? parsed : parsed.results;
      const { data } = await axios.post(
        '/api/v1/settings/mapping/overrides/import',
        { overrides }
      );
      addToast(
        `Imported ${data.imported} override(s), skipped ${data.skipped}.`,
        { appearance: 'success', autoDismiss: true }
      );
      revalidateGaps();
    } catch {
      addToast('Unable to import overrides.', {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const today = new Date().toISOString().slice(0, 10);
  const usageToday = (health?.usage ?? []).filter((row) => row.day === today);

  return (
    <>
      <PageTitle title="Mapping" />
      {repairing && (
        <MappingRepairModal
          gap={repairing}
          onClose={() => setRepairing(null)}
          onResolved={() => {
            setRepairing(null);
            revalidateGaps();
            revalidateHealth();
          }}
        />
      )}

      <div className="mb-6">
        <h3 className="heading">Mapping health</h3>
        <p className="description">
          Every discover item that could not be resolved to a TMDB id, and the
          request budget each source is spending to resolve the rest.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Open gaps" value={health?.gaps.openGaps ?? 0} />
        <Stat label="Total sightings" value={health?.gaps.totalHits ?? 0} />
        <Stat label="Ambiguous" value={health?.gaps.byReason?.ambiguous ?? 0} />
        <Stat
          label="Requests today"
          value={usageToday.reduce((sum, row) => sum + row.requests, 0)}
        />
      </div>

      {!!health?.providers?.length && (
        <div className="mt-8">
          <h3 className="heading">Provider access</h3>
          <p className="description">
            Access the mapping layer depends on but does not control. A failing
            provider here looks like a mapping fault from the outside.
          </p>
          <ul className="mt-3 space-y-2">
            {health.providers.map((provider) => (
              <li
                key={provider.key}
                className="flex items-start justify-between rounded-md bg-gray-800 p-3 ring-1 ring-gray-700"
              >
                <div>
                  <div className="font-medium text-white">{provider.key}</div>
                  {provider.detail && (
                    <div className="mt-1 text-xs text-gray-400">
                      {provider.detail}
                    </div>
                  )}
                </div>
                <span
                  className={`rounded px-2 py-1 text-xs ${
                    provider.state === 'ok'
                      ? 'bg-green-700 text-white'
                      : provider.state === 'unconfigured'
                        ? 'bg-gray-600 text-white'
                        : 'bg-red-600 text-white'
                  }`}
                >
                  {provider.state}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-8">
        <h3 className="heading">Sources</h3>
        <p className="description">
          Packs and live resolvers, with the daily request volume and breaker
          state for each.
        </p>
        <Table>
          <thead>
            <tr>
              <Table.TH>Source</Table.TH>
              <Table.TH>Entries</Table.TH>
              <Table.TH>Requests today</Table.TH>
              <Table.TH>Breaker</Table.TH>
              <Table.TH>Licence</Table.TH>
              <Table.TH className="text-right">Actions</Table.TH>
            </tr>
          </thead>
          <Table.TBody>
            {(health?.sources ?? []).map((source) => {
              const budget = health?.budgets.find(
                (entry) => entry.key === source.key
              );
              const usage = usageToday.find(
                (row) => row.sourceKey === source.key
              );
              const state = budget?.circuitState ?? source.circuitState;
              return (
                <tr key={source.key}>
                  <Table.TD>
                    <div className="font-medium text-white">{source.key}</div>
                    <div className="text-xs text-gray-400">
                      {source.kind} · trust {source.trust} · priority{' '}
                      {source.priority}
                    </div>
                    {source.lastError && (
                      <div className="mt-1 text-xs text-red-400">
                        {source.lastError}
                      </div>
                    )}
                    {(refreshByKey.get(source.key) ||
                      refreshingKeys.includes(source.key)) && (
                      <PackProgress
                        progress={
                          refreshByKey.get(source.key) ?? {
                            key: source.key,
                            phase: 'downloading',
                            startedAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString(),
                          }
                        }
                      />
                    )}
                  </Table.TD>
                  <Table.TD>{source.entryCount ?? '—'}</Table.TD>
                  <Table.TD>
                    {usage?.requests ?? budget?.requestsToday ?? 0}
                    {source.dailyQuota ? ` / ${source.dailyQuota}` : ''}
                  </Table.TD>
                  <Table.TD>
                    <span
                      className={`rounded px-2 py-1 text-xs ${circuitStyle(state)}`}
                    >
                      {state ?? 'closed'}
                    </span>
                  </Table.TD>
                  <Table.TD>
                    <div className="text-xs text-gray-300">
                      {source.licence ?? 'unknown'}
                    </div>
                    {source.legalNote && (
                      <div className="text-xs text-yellow-500">
                        {source.legalNote}
                      </div>
                    )}
                  </Table.TD>
                  <Table.TD alignText="right">
                    <div className="flex justify-end gap-2">
                      {source.kind === 'pack' && (
                        <Button
                          buttonType="primary"
                          buttonSize="sm"
                          disabled={
                            refreshingKeys.includes(source.key) ||
                            refreshByKey.has(source.key)
                          }
                          onClick={() => refreshPack(source.key)}
                        >
                          {refreshByKey.has(source.key) ||
                          refreshingKeys.includes(source.key)
                            ? 'Refreshing…'
                            : 'Refresh'}
                        </Button>
                      )}
                      {state && state !== 'closed' && (
                        <Button
                          buttonType="warning"
                          buttonSize="sm"
                          onClick={() => resetCircuit(source.key)}
                        >
                          Reset breaker
                        </Button>
                      )}
                      <Button
                        buttonType={source.enabled ? 'danger' : 'default'}
                        buttonSize="sm"
                        onClick={() => toggleSource(source)}
                      >
                        {source.enabled ? 'Disable' : 'Enable'}
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
        <div className="flex items-end justify-between">
          <div>
            <h3 className="heading">Repair queue</h3>
            <p className="description">
              Unresolved items, most-seen first. A correction is stored as an
              override and takes precedence over every other resolver.
            </p>
          </div>
          <div className="flex gap-2">
            <Button buttonType="default" onClick={suggestMatches}>
              Suggest matches
            </Button>
            <Button buttonType="default" onClick={exportOverrides}>
              Export overrides
            </Button>
            <label className="inline-flex cursor-pointer items-center rounded-md border border-gray-500 px-4 py-2 text-sm text-white">
              Import overrides
              <input
                type="file"
                accept="application/json"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) importOverrides(file);
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
              <Table.TH>Source</Table.TH>
              <Table.TH>Reason</Table.TH>
              <Table.TH>Hits</Table.TH>
              <Table.TH className="text-right">Actions</Table.TH>
            </tr>
          </thead>
          <Table.TBody>
            {(gaps?.results ?? []).map((gap) => (
              <tr key={gap.id}>
                <Table.TD>
                  <div className="font-medium text-white">
                    {gap.title ?? `${gap.namespace}:${gap.externalId}`}
                  </div>
                  <div className="text-xs text-gray-400">
                    {gap.namespace}:{gap.externalId}
                    {gap.season >= 0 ? ` · season ${gap.season}` : ''}
                    {gap.rejectedTarget
                      ? ` · rejected ${gap.rejectedTarget}`
                      : ''}
                  </div>
                  {gap.suggestedTarget && (
                    <div className="text-xs text-amber-300">
                      suggested {gap.suggestedTarget} (unverified)
                    </div>
                  )}
                </Table.TD>
                <Table.TD>{gap.discoverSource ?? '—'}</Table.TD>
                <Table.TD>{gap.reason}</Table.TD>
                <Table.TD>{gap.hitCount}</Table.TD>
                <Table.TD alignText="right">
                  <Button
                    buttonType="primary"
                    buttonSize="sm"
                    onClick={() => setRepairing(gap)}
                  >
                    Fix mapping
                  </Button>
                </Table.TD>
              </tr>
            ))}
            {!gaps?.results.length && (
              <tr>
                <Table.TD colSpan={5}>
                  <div className="py-6 text-center text-gray-400">
                    No open mapping gaps.
                  </div>
                </Table.TD>
              </tr>
            )}
          </Table.TBody>
        </Table>
      </div>
    </>
  );
};

export default SettingsMapping;
