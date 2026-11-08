import CachedImage from '@app/components/Common/CachedImage';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { CalendarDaysIcon } from '@heroicons/react/24/outline';
import type { AiRun } from '@shared/interfaces/api/aiInterfaces';
import { visibleAiPicks } from '@shared/lib/aiVisibility';
import { Permission } from '@shared/lib/permissions';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Ai.AiPicks.WeeklyPicks', {
  title: 'This week for you',
  open: 'See all {count} picks',
  hint: 'Made for your taste each week. Turn it off in Profile → Discover.',
});

/** The person's latest weekly picks, as a small strip that opens them. */
const WeeklyPicks = ({ onOpen }: { onOpen: (id: number) => void }) => {
  const intl = useIntl();
  const settings = useSettings();
  const { hasPermission } = useUser();
  const { data } = useSWR<{ run: AiRun | null }>('/api/v1/ai/weekly');
  const run = data?.run;
  const picks = visibleAiPicks(
    run?.result?.picks ?? [],
    settings.currentSettings,
    hasPermission([Permission.MANAGE_BLOCKLIST, Permission.VIEW_BLOCKLIST], {
      type: 'or',
    }),
    run?.request.availability
  );
  if (!run || picks.length === 0) {
    return null;
  }
  return (
    <section
      className="mt-6 max-w-5xl rounded-xl border border-indigo-500/40 bg-gradient-to-r from-indigo-900/40 to-gray-800/40 p-4"
      aria-labelledby="ai-weekly"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="ai-weekly"
            className="flex items-center gap-2 text-base font-bold text-white"
          >
            <CalendarDaysIcon className="h-5 w-5 text-indigo-300" />
            {intl.formatMessage(messages.title)}
          </h2>
          {run.result?.headline ? (
            <p className="mt-0.5 truncate text-sm text-gray-300">
              {run.result.headline}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => onOpen(run.id)}
          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
        >
          {intl.formatMessage(messages.open, { count: picks.length })}
        </button>
      </div>
      <div
        className="mt-3 flex w-full gap-2 overflow-hidden"
        aria-hidden="true"
      >
        {picks.slice(0, 10).map((p) => {
          const poster = (p.item as { posterPath?: string }).posterPath;
          return (
            <span
              key={`${p.mediaType}-${p.tmdbId}`}
              className="relative h-24 w-16 shrink-0 overflow-hidden rounded-md bg-gray-700"
            >
              {poster ? (
                <CachedImage
                  type="tmdb"
                  src={`https://image.tmdb.org/t/p/w154${poster}`}
                  alt=""
                  fill
                  style={{ objectFit: 'cover' }}
                />
              ) : null}
            </span>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-gray-400">
        {intl.formatMessage(messages.hint)}
      </p>
    </section>
  );
};

export default WeeklyPicks;
