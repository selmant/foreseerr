import CachedImage from '@app/components/Common/CachedImage';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import { ClockIcon, TrashIcon } from '@heroicons/react/24/outline';
import type { AiRunSummary } from '@shared/interfaces/api/aiInterfaces';
import axios from 'axios';
import { useState } from 'react';
import { FormattedRelativeTime, useIntl } from 'react-intl';

const messages = defineMessages('components.Ai.AiPicks.RecentRequests', {
  recent: 'Recent',
  clearAll: 'Clear history',
  clearConfirm: 'Delete all?',
  cleared: 'Your AI request history was deleted.',
  deleteOne: 'Delete “{title}”',
  failed: 'Couldn’t delete that. Try again.',
  moreLike: 'More like {title}',
  picks: '{count, plural, one {# pick} other {# picks}}',
  requested: '{count} requested',
  liked: '{count} liked',
  movies: 'Movies',
  series: 'Series',
  anime: 'Anime',
  library: 'In library',
  notInLibrary: 'Not in library',
  refined: '{count, plural, one {# refinement} other {# refinements}}',
  runFailed: 'Failed',
});

interface RecentRequestsProps {
  runs: AiRunSummary[];
  /** The run on screen, left out of the list. */
  currentId: number | null;
  onOpen: (id: number) => void;
  /** Called after deleting, to reload the list; `all` after clearing it. */
  onChanged: (all: boolean) => void;
}

const titleOf = (
  r: AiRunSummary,
  moreLike: (title: string) => string
): string =>
  r.prompt || (r.seedTitle ? moreLike(r.seedTitle) : (r.headline ?? ''));

/** Earlier requests with what was asked, a few posters and how they went. */
const RecentRequests = ({
  runs,
  currentId,
  onOpen,
  onChanged,
}: RecentRequestsProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [busy, setBusy] = useState(false);
  const moreLike = (title: string) =>
    intl.formatMessage(messages.moreLike, { title });

  const finished = (r: AiRunSummary) =>
    r.stage === 'done' || r.stage === 'failed';
  const sameRequest = (a: AiRunSummary, b: AiRunSummary) =>
    a.prompt === b.prompt &&
    (a.seed
      ? a.seed.mediaType === b.seed?.mediaType &&
        a.seed.tmdbId === b.seed.tmdbId
      : !b.seed && a.seedTitle === b.seedTitle) &&
    a.only === b.only &&
    a.anime === b.anime &&
    a.availability === b.availability &&
    (a.refinements ?? []).join('|') === (b.refinements ?? []).join('|');

  const shown = runs
    .filter(
      (r, i, all) =>
        r.id !== currentId &&
        finished(r) &&
        // Only the latest finished run of each request.
        all.findIndex((o) => finished(o) && sameRequest(o, r)) === i
    )
    .slice(0, 10);

  const remove = async (path: string, all: boolean, done?: string) => {
    setBusy(true);
    try {
      await axios.delete(path);
      if (done) {
        addToast(done, { appearance: 'success', autoDismiss: true });
      }
      onChanged(all);
    } catch {
      addToast(intl.formatMessage(messages.failed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setBusy(false);
    }
  };

  if (shown.length === 0) {
    return null;
  }

  return (
    <section className="mt-10 max-w-5xl" aria-labelledby="ai-recent">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3
          id="ai-recent"
          className="flex items-center gap-2 text-sm font-semibold text-gray-300"
        >
          <ClockIcon className="h-4 w-4" />
          {intl.formatMessage(messages.recent)}
        </h3>
        <ConfirmButton
          onClick={() =>
            void remove(
              '/api/v1/ai/runs',
              true,
              intl.formatMessage(messages.cleared)
            )
          }
          confirmText={intl.formatMessage(messages.clearConfirm)}
          disabled={busy}
          className="!h-8 !px-3 !text-xs"
        >
          <TrashIcon className="mr-1 h-4 w-4" />
          <span>{intl.formatMessage(messages.clearAll)}</span>
        </ConfirmButton>
      </div>
      <ul className="grid grid-cols-1 gap-2 lg:grid-cols-2">
        {shown.map((r) => {
          const title = titleOf(r, moreLike);
          const failed = r.stage === 'failed';
          const meta: string[] = [];
          if (r.anime) meta.push(intl.formatMessage(messages.anime));
          else if (r.only === 'movie')
            meta.push(intl.formatMessage(messages.movies));
          else if (r.only === 'tv')
            meta.push(intl.formatMessage(messages.series));
          if (r.availability === 'library')
            meta.push(intl.formatMessage(messages.library));
          if (r.availability === 'new')
            meta.push(intl.formatMessage(messages.notInLibrary));
          if (r.refinements?.length)
            meta.push(
              intl.formatMessage(messages.refined, {
                count: r.refinements.length,
              })
            );
          return (
            <li
              key={r.id}
              className="group relative flex min-w-0 items-center gap-3 rounded-xl border border-gray-700 bg-gray-800/50 p-2 pr-11 transition hover:border-gray-500 hover:bg-gray-800"
            >
              <button
                type="button"
                onClick={() => onOpen(r.id)}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
              >
                <span className="flex shrink-0 -space-x-5" aria-hidden="true">
                  {(r.posters.length ? r.posters : [null])
                    .slice(0, 3)
                    .map((p, i) => (
                      <span
                        key={p ?? i}
                        className="relative h-14 w-10 overflow-hidden rounded-md bg-gray-700 ring-2 ring-gray-800"
                        style={{ zIndex: 3 - i }}
                      >
                        {p ? (
                          <CachedImage
                            type="tmdb"
                            src={`https://image.tmdb.org/t/p/w92${p}`}
                            alt=""
                            fill
                            style={{ objectFit: 'cover' }}
                          />
                        ) : null}
                      </span>
                    ))}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-white">
                    {title}
                  </span>
                  {failed ? (
                    r.error ? (
                      <span className="block truncate text-xs text-red-300/80">
                        {r.error}
                      </span>
                    ) : null
                  ) : r.headline && r.headline !== title ? (
                    <span className="block truncate text-xs text-gray-400">
                      {r.headline}
                    </span>
                  ) : null}
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-gray-500">
                    <FormattedRelativeTime
                      value={Math.floor(
                        (new Date(r.createdAt).getTime() - Date.now()) / 1000
                      )}
                      updateIntervalInSeconds={60}
                      numeric="auto"
                    />
                    {failed ? (
                      <span className="font-medium text-red-400">
                        {intl.formatMessage(messages.runFailed)}
                      </span>
                    ) : (
                      <span>
                        {intl.formatMessage(messages.picks, {
                          count: r.pickCount,
                        })}
                      </span>
                    )}
                    {meta.map((m) => (
                      <span key={m}>{m}</span>
                    ))}
                    {r.requested > 0 ? (
                      <span className="text-green-400">
                        {intl.formatMessage(messages.requested, {
                          count: r.requested,
                        })}
                      </span>
                    ) : null}
                    {r.liked > 0 ? (
                      <span className="text-indigo-300">
                        {intl.formatMessage(messages.liked, {
                          count: r.liked,
                        })}
                      </span>
                    ) : null}
                  </span>
                </span>
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove(`/api/v1/ai/runs/${r.id}`, false)}
                aria-label={intl.formatMessage(messages.deleteOne, { title })}
                className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-lg text-gray-500 transition hover:bg-gray-700 hover:text-red-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:opacity-50"
              >
                <TrashIcon className="h-4 w-4" />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

export default RecentRequests;
