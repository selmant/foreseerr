import defineMessages from '@app/utils/defineMessages';
import { ChartBarIcon } from '@heroicons/react/24/outline';
import type { AiUsageReport } from '@shared/interfaces/api/aiInterfaces';
import { FormattedRelativeTime, useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Settings.SettingsAi.AiUsagePanel', {
  title: 'Usage',
  description:
    'The last {days} days. Tokens are what the provider reported; picks “requested” or “watched” happened after the title was suggested.',
  loadFailed: 'Usage couldn’t be loaded.',
  monthTokens: 'Server tokens this month',
  ofBudget: 'of {budget}',
  noBudget: 'No monthly budget',
  requests: 'Requests',
  hitRate: 'Picks requested',
  hitRateValue: '{requested} of {picks} picks',
  people: 'People',
  person: 'Person',
  asked: 'Asked',
  automatic: 'Automatic',
  today: 'Today',
  failed: 'Failed',
  tokens: 'Tokens',
  picks: 'Picks',
  requested: 'Requested',
  watched: 'Watched',
  liked: 'Liked',
  models: 'Models',
  model: 'Model',
  avgTokens: 'Tokens per request',
  ratedWell: 'Rated 7+',
  unknownModel: 'Unknown',
  failures: 'Recent failures',
  nothing: 'No AI requests in this period yet.',
});

const Tile = ({
  label,
  value,
  sub,
  meter,
}: {
  label: string;
  value: string;
  sub?: string;
  meter?: number;
}) => (
  <div className="rounded-lg border border-gray-700 bg-gray-900/40 p-3">
    <div className="text-xs text-gray-400">{label}</div>
    <div className="mt-1 text-xl font-semibold text-white">{value}</div>
    {sub ? <div className="text-xs text-gray-500">{sub}</div> : null}
    {meter !== undefined ? (
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-700"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(meter * 100)}
        aria-label={label}
      >
        <div
          className={`h-full ${meter >= 1 ? 'bg-red-500' : meter >= 0.8 ? 'bg-yellow-500' : 'bg-indigo-500'}`}
          style={{ width: `${Math.min(100, meter * 100)}%` }}
        />
      </div>
    ) : null}
  </div>
);

const th = 'px-3 py-2 text-left text-xs font-medium text-gray-400';
const td = 'px-3 py-2 text-sm text-gray-200 tabular-nums';

/** Admin view of who used AI, how many tokens, and how picks went. */
const AiUsagePanel = () => {
  const intl = useIntl();
  const { data, error } = useSWR<AiUsageReport>('/api/v1/settings/ai/usage');
  const num = (n: number) =>
    intl.formatNumber(n, { notation: n >= 10_000 ? 'compact' : 'standard' });
  const pct = (part: number, whole: number) =>
    whole > 0
      ? intl.formatNumber(part / whole, {
          style: 'percent',
          maximumFractionDigits: 0,
        })
      : '–';

  const totalRuns = data?.people.reduce((n, p) => n + p.runs, 0) ?? 0;
  const totalPicks =
    data?.people.reduce((n, p) => n + p.outcomes.picks, 0) ?? 0;
  const totalRequested =
    data?.people.reduce((n, p) => n + p.outcomes.requested, 0) ?? 0;

  return (
    <section
      className="mb-8 rounded-xl border border-gray-700 bg-gray-800/40 p-4 sm:p-6"
      aria-labelledby="ai-usage"
      data-testid="ai-usage"
    >
      <h3
        id="ai-usage"
        className="flex items-center gap-2 text-lg font-semibold text-gray-100"
      >
        <ChartBarIcon className="h-5 w-5" />
        {intl.formatMessage(messages.title)}
      </h3>
      <p className="description">
        {intl.formatMessage(messages.description, { days: data?.days ?? 30 })}
      </p>
      {error ? (
        <p className="mt-3 text-sm text-red-400">
          {intl.formatMessage(messages.loadFailed)}
        </p>
      ) : null}
      {data ? (
        <>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Tile
              label={intl.formatMessage(messages.monthTokens)}
              value={num(data.month.serverTokens)}
              sub={
                data.month.budget > 0
                  ? intl.formatMessage(messages.ofBudget, {
                      budget: num(data.month.budget),
                    })
                  : intl.formatMessage(messages.noBudget)
              }
              meter={
                data.month.budget > 0
                  ? data.month.serverTokens / data.month.budget
                  : undefined
              }
            />
            <Tile
              label={intl.formatMessage(messages.requests)}
              value={num(totalRuns)}
            />
            <Tile
              label={intl.formatMessage(messages.hitRate)}
              value={pct(totalRequested, totalPicks)}
              sub={intl.formatMessage(messages.hitRateValue, {
                requested: num(totalRequested),
                picks: num(totalPicks),
              })}
            />
          </div>

          {data.people.length === 0 ? (
            <p className="mt-4 text-sm text-gray-400">
              {intl.formatMessage(messages.nothing)}
            </p>
          ) : (
            <>
              <h4 className="mt-6 text-sm font-semibold text-gray-300">
                {intl.formatMessage(messages.people)}
              </h4>
              <div className="mt-2 overflow-x-auto rounded-lg border border-gray-700">
                <table className="min-w-full divide-y divide-gray-700">
                  <thead className="bg-gray-900/40">
                    <tr>
                      {(
                        [
                          'person',
                          'asked',
                          'automatic',
                          'today',
                          'failed',
                          'tokens',
                          'picks',
                          'requested',
                          'watched',
                          'liked',
                        ] as const
                      ).map((k) => (
                        <th key={k} scope="col" className={th}>
                          {intl.formatMessage(messages[k])}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {data.people.map((p) => (
                      <tr key={p.userId}>
                        <td className={`${td} whitespace-nowrap font-medium`}>
                          {p.name}
                        </td>
                        <td className={td}>{num(p.manual)}</td>
                        <td className={td}>{num(p.automatic)}</td>
                        <td className={td}>{num(p.today)}</td>
                        <td className={td}>
                          {p.failed > 0 ? (
                            <span className="text-red-400">
                              {num(p.failed)}
                            </span>
                          ) : (
                            0
                          )}
                        </td>
                        <td className={td}>{num(p.tokens)}</td>
                        <td className={td}>{num(p.outcomes.picks)}</td>
                        <td className={td}>{num(p.outcomes.requested)}</td>
                        <td className={td}>{num(p.outcomes.watched)}</td>
                        <td className={td}>{num(p.outcomes.liked)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h4 className="mt-6 text-sm font-semibold text-gray-300">
                {intl.formatMessage(messages.models)}
              </h4>
              <div className="mt-2 overflow-x-auto rounded-lg border border-gray-700">
                <table className="min-w-full divide-y divide-gray-700">
                  <thead className="bg-gray-900/40">
                    <tr>
                      {(
                        [
                          'model',
                          'requests',
                          'failed',
                          'avgTokens',
                          'picks',
                          'requested',
                          'watched',
                          'ratedWell',
                        ] as const
                      ).map((k) => (
                        <th key={k} scope="col" className={th}>
                          {intl.formatMessage(messages[k])}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    {data.models.map((m) => (
                      <tr key={m.model ?? ''}>
                        <td className={`${td} whitespace-nowrap font-medium`}>
                          {m.model ?? intl.formatMessage(messages.unknownModel)}
                        </td>
                        <td className={td}>{num(m.runs)}</td>
                        <td className={td}>{num(m.failed)}</td>
                        <td className={td}>
                          {num(
                            m.runs > 0
                              ? Math.round(
                                  (m.inputTokens + m.outputTokens) / m.runs
                                )
                              : 0
                          )}
                        </td>
                        <td className={td}>{num(m.picks)}</td>
                        <td className={td}>
                          {num(m.requested)}{' '}
                          <span className="text-xs text-gray-500">
                            ({pct(m.requested, m.picks)})
                          </span>
                        </td>
                        <td className={td}>{num(m.watched)}</td>
                        <td className={td}>{num(m.ratedWell)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {data.failures.length > 0 ? (
            <>
              <h4 className="mt-6 text-sm font-semibold text-gray-300">
                {intl.formatMessage(messages.failures)}
              </h4>
              <ul className="mt-2 divide-y divide-gray-800 rounded-lg border border-gray-700">
                {data.failures.map((f) => (
                  <li key={f.id} className="px-3 py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-x-2 text-xs text-gray-400">
                      <span className="font-medium text-gray-200">
                        {f.name}
                      </span>
                      <FormattedRelativeTime
                        value={Math.floor(
                          (new Date(f.createdAt).getTime() - Date.now()) / 1000
                        )}
                        updateIntervalInSeconds={60}
                        numeric="auto"
                      />
                      {f.model ? <span>{f.model}</span> : null}
                      <span>{f.origin}</span>
                    </div>
                    {f.message ? (
                      <p className="mt-0.5 text-gray-300">{f.message}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
};

export default AiUsagePanel;
