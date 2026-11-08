import AiPickCard from '@app/components/Ai/AiPickCard';
import { aiErrorOf } from '@app/components/Ai/aiError';
import {
  isWorking,
  sendFeedback,
  useAiRun,
  withFeedback,
} from '@app/components/Ai/useAiRun';
import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import PageTitle from '@app/components/Common/PageTitle';
import type { SegmentedOption } from '@app/components/Common/SegmentedControl';
import SegmentedControl from '@app/components/Common/SegmentedControl';
import Placeholder from '@app/components/TitleCard/Placeholder';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowPathIcon,
  CheckIcon,
  ClockIcon,
  GlobeAltIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  SparklesIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { DiscoverSliderType } from '@shared/constants/discover';
import type DiscoverSlider from '@shared/entity/DiscoverSlider';
import type {
  AiErrorBody,
  AiMe,
  AiPick,
  AiRecommendRequest,
  AiRun,
  AiRunStage,
  AiRunSummary,
  AiVerdict,
} from '@shared/interfaces/api/aiInterfaces';
import axios from 'axios';
import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { Link, useSearchParams } from 'react-router';
import useSWR, { mutate as globalMutate } from 'swr';

const messages = defineMessages('components.Ai.AiPicks', {
  title: 'AI Picks',
  heading: 'What do you feel like watching?',
  subheading:
    'Describe a mood, a vibe or a title you love. Foreseerr searches real catalogs and picks what fits your taste.',
  placeholder: 'A cozy mystery for a rainy night…',
  find: 'Find picks',
  any: 'All',
  movies: 'Movies',
  series: 'Series',
  anime: 'Anime',
  kindLabel: 'What kind',
  moreLike: 'More like {title}',
  clearSeed: 'Remove',
  moodCozy: 'Cozy & comforting',
  moodMind: 'Mind-bending',
  moodFeelGood: 'Feel-good',
  moodDark: 'Dark & gritty',
  moodEpic: 'Epic adventure',
  moodLaugh: 'Laugh out loud',
  moodGems: 'Hidden gems',
  moodShort: 'Short & light',
  moodTaste: 'Just for me',
  promptCozy: 'Something cozy and comforting to unwind with',
  promptMind: 'Mind-bending, twisty stories that make me think',
  promptFeelGood: 'Feel-good and uplifting',
  promptDark: 'Dark, gritty and intense',
  promptEpic: 'Big epic adventures with great world-building',
  promptLaugh: 'Genuinely funny, laugh-out-loud comedy',
  promptGems: 'Underrated hidden gems most people missed',
  promptShort: 'Something short and light, under 100 minutes or a short series',
  promptTaste: 'Based on my taste',
  stagePlanning: 'Understanding what you want',
  stageSearching: 'Searching TMDB, AniList and Trakt',
  stageRanking: 'Picking the best fits',
  pickedFrom: '{picks} picks from {candidates} titles found',
  usedWeb: 'Web search used',
  refine: 'Refine',
  tryAgain: 'Try again',
  startOver: 'Start over',
  addToDiscover: 'Add to Discover',
  addedToDiscover:
    'Added to the top of Discover. Each person sees picks for their own taste.',
  addToDiscoverFailed: 'Couldn’t add the row to Discover.',
  recent: 'Recent',
  feedbackFailed: 'Couldn’t save that. Try again.',
  using: 'Using {connection}',
  usingServer: 'the server connection',
  usingOwnChatgpt: 'your ChatGPT plan',
  usingOwnEndpoint: 'your own endpoint',
  left: '{left} of {limit} left today',
  setup: 'Set up AI in Profile → AI',
  unavailableOwn:
    'Your own AI connection needs attention. Fix it, or switch back to the server connection.',
  unavailableNone:
    'There’s no AI connection you can use yet. Connect your own account, or ask your admin.',
  feedbackHint:
    'Tap 👍 or 👎 under a title, or mark it seen. Foreseerr learns your taste from it.',
  tasteLink: 'Your taste card',
});

type Kind = 'any' | 'movie' | 'tv' | 'anime';

const MOODS: { label: keyof typeof messages; prompt: keyof typeof messages }[] =
  [
    { label: 'moodCozy', prompt: 'promptCozy' },
    { label: 'moodMind', prompt: 'promptMind' },
    { label: 'moodFeelGood', prompt: 'promptFeelGood' },
    { label: 'moodDark', prompt: 'promptDark' },
    { label: 'moodEpic', prompt: 'promptEpic' },
    { label: 'moodLaugh', prompt: 'promptLaugh' },
    { label: 'moodGems', prompt: 'promptGems' },
    { label: 'moodShort', prompt: 'promptShort' },
    { label: 'moodTaste', prompt: 'promptTaste' },
  ];

const STAGES: { stage: AiRunStage; label: keyof typeof messages }[] = [
  { stage: 'planning', label: 'stagePlanning' },
  { stage: 'searching', label: 'stageSearching' },
  { stage: 'ranking', label: 'stageRanking' },
];

const parseSeed = (
  value: string | null
): { mediaType: 'movie' | 'tv'; tmdbId: number } | null => {
  const match = value?.match(/^(movie|tv):(\d+)$/);
  return match
    ? { mediaType: match[1] as 'movie' | 'tv', tmdbId: Number(match[2]) }
    : null;
};

const Chip = ({
  children,
  onClick,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    className="rounded-full border border-gray-600 bg-gray-800/70 px-3.5 py-1.5 text-sm text-gray-200 transition hover:border-indigo-400 hover:bg-indigo-600/30 hover:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
  >
    {children}
  </button>
);

const StageSteps = ({ stage }: { stage: AiRunStage }) => {
  const intl = useIntl();
  const current = STAGES.findIndex((s) => s.stage === stage);
  return (
    <ol className="flex flex-col gap-2 sm:flex-row sm:gap-6" role="status">
      {STAGES.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li
            key={s.stage}
            className={`flex items-center gap-2 text-sm ${
              active ? 'text-white' : done ? 'text-gray-400' : 'text-gray-500'
            }`}
          >
            <span
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
                done
                  ? 'bg-green-600'
                  : active
                    ? 'bg-indigo-600'
                    : 'border border-gray-600'
              }`}
            >
              {done ? (
                <CheckIcon className="h-4 w-4 text-white" />
              ) : active ? (
                <ArrowPathIcon className="h-4 w-4 animate-spin text-white" />
              ) : null}
            </span>
            {intl.formatMessage(messages[s.label])}
          </li>
        );
      })}
    </ol>
  );
};

const AiPicks = () => {
  const intl = useIntl();
  const settings = useSettings();
  const { addToast } = useToasts();
  const { hasPermission } = useUser();
  const [searchParams, setSearchParams] = useSearchParams();
  const runParam = Number(searchParams.get('run')) || null;
  const seed = parseSeed(searchParams.get('seed'));
  const [prompt, setPrompt] = useState(searchParams.get('q') ?? '');
  const [kind, setKind] = useState<Kind>('any');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<AiErrorBody | null>(null);
  const autoStarted = useRef(false);

  const { data: me, mutate: mutateMe } = useSWR<AiMe>('/api/v1/ai/me');
  const { data: recent, mutate: mutateRecent } =
    useSWR<AiRunSummary[]>('/api/v1/ai/runs');
  const { data: run, mutate: mutateRun } = useAiRun(runParam);
  const { data: seedTitle } = useSWR<{ title?: string; name?: string }>(
    seed && !runParam ? `/api/v1/${seed.mediaType}/${seed.tmdbId}` : null
  );

  const working = starting || isWorking(run);

  const start = async (request: AiRecommendRequest) => {
    setStarting(true);
    setStartError(null);
    try {
      const res = await axios.post<AiRun>('/api/v1/ai/recommend', request);
      globalMutate(`/api/v1/ai/runs/${res.data.id}`, res.data, {
        revalidate: false,
      });
      const next = new URLSearchParams();
      next.set('run', String(res.data.id));
      setSearchParams(next);
      mutateMe();
      mutateRecent();
    } catch (e) {
      setStartError(aiErrorOf(e, intl.formatMessage(globalMessages.error)));
    } finally {
      setStarting(false);
    }
  };

  const requestFor = (text: string): AiRecommendRequest => ({
    prompt: text.trim(),
    seed: !runParam ? seed : null,
    only: kind === 'movie' || kind === 'tv' ? kind : null,
    anime: kind === 'anime',
    refinements: [],
  });

  // "More like this" and ?q= links start right away, once.
  useEffect(() => {
    if (autoStarted.current || runParam || !me?.effective.available) {
      return;
    }
    const q = searchParams.get('q');
    if (seed || q) {
      autoStarted.current = true;
      void start(requestFor(q ?? ''));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.effective.available, runParam]);

  // Refresh usage and the recent list when a run finishes.
  useEffect(() => {
    if (run && !isWorking(run)) {
      mutateMe();
      mutateRecent();
    }
  }, [run?.stage, run, mutateMe, mutateRecent]);

  if (!settings.currentSettings.aiEnabled) {
    return <ErrorPage statusCode={404} />;
  }

  const onFeedback = async (pick: AiPick, verdict: AiVerdict | null) => {
    if (!run) {
      return;
    }
    const previous = run;
    mutateRun(withFeedback(run, pick, verdict), { revalidate: false });
    try {
      await sendFeedback(pick, verdict);
    } catch {
      mutateRun(previous, { revalidate: false });
      addToast(intl.formatMessage(messages.feedbackFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const refine = (chip: string) => {
    if (!run) {
      return;
    }
    void start({
      prompt: run.request.prompt,
      seed: run.request.seed
        ? {
            mediaType: run.request.seed.mediaType,
            tmdbId: run.request.seed.tmdbId,
          }
        : null,
      only: run.request.only,
      anime: run.request.anime,
      refinements: [...run.request.refinements, chip].slice(-6),
    });
  };

  const retry = () => {
    if (!run) {
      return;
    }
    void start({
      prompt: run.request.prompt,
      seed: run.request.seed
        ? {
            mediaType: run.request.seed.mediaType,
            tmdbId: run.request.seed.tmdbId,
          }
        : null,
      only: run.request.only,
      anime: run.request.anime,
      refinements: run.request.refinements,
    });
  };

  const addToDiscover = async () => {
    if (!run) {
      return;
    }
    const text = run.request.prompt;
    try {
      const added = await axios.post<DiscoverSlider>(
        '/api/v1/settings/discover/add',
        {
          type: DiscoverSliderType.AI_PICKS,
          title: (run.result?.headline || text).slice(0, 80),
          data: text,
        }
      );
      // New rows start hidden at the end; show this one first.
      const all = await axios.get<DiscoverSlider[]>(
        '/api/v1/settings/discover'
      );
      await axios.post('/api/v1/settings/discover', [
        { ...added.data, enabled: true },
        ...all.data.filter((s) => s.id !== added.data.id),
      ]);
      globalMutate('/api/v1/settings/discover');
      addToast(intl.formatMessage(messages.addedToDiscover), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch {
      addToast(intl.formatMessage(messages.addToDiscoverFailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const kindOptions: SegmentedOption<Kind>[] = [
    { value: 'any', label: intl.formatMessage(messages.any) },
    { value: 'movie', label: intl.formatMessage(messages.movies) },
    { value: 'tv', label: intl.formatMessage(messages.series) },
    { value: 'anime', label: intl.formatMessage(messages.anime) },
  ];

  const effective = me?.effective;
  const connectionLabel = effective?.available
    ? intl.formatMessage(messages.using, {
        connection:
          effective.source === 'server'
            ? intl.formatMessage(messages.usingServer)
            : effective.usesChatgptPlan
              ? intl.formatMessage(messages.usingOwnChatgpt)
              : intl.formatMessage(messages.usingOwnEndpoint),
      }) + (effective.model ? ` · ${effective.model}` : '')
    : null;
  const usage = me?.usage;
  const left =
    usage?.dailyLimit != null
      ? Math.max(0, usage.dailyLimit - usage.usedToday)
      : null;

  const seedName = run
    ? run.request.seed?.title
    : (seedTitle?.title ?? seedTitle?.name);
  const showSeed = (run ? !!run.request.seed : !!seed) && !!seedName;
  const error = startError ?? (run?.stage === 'failed' ? run.error : null);

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.title)} />
      <div className="mt-4 max-w-5xl">
        <div className="flex items-start gap-3">
          <SparklesIcon className="mt-1 h-7 w-7 shrink-0 text-indigo-400" />
          <div>
            <h1 className="text-2xl font-bold text-white sm:text-3xl">
              {intl.formatMessage(messages.heading)}
            </h1>
            <p className="mt-1 text-sm text-gray-400">
              {intl.formatMessage(messages.subheading)}
            </p>
          </div>
        </div>

        {me && !me.effective.available ? (
          <div className="mt-5">
            <Alert
              type="warning"
              title={intl.formatMessage(
                me.effective.reason === 'own_missing' ||
                  me.effective.reason === 'own_needs_sign_in'
                  ? messages.unavailableOwn
                  : messages.unavailableNone
              )}
            >
              <Link
                to="/profile/settings/ai"
                className="font-semibold underline"
              >
                {intl.formatMessage(messages.setup)}
              </Link>
            </Alert>
          </div>
        ) : null}

        <form
          className="mt-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!working) {
              void start(requestFor(prompt));
            }
          }}
        >
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <MagnifyingGlassIcon className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                value={prompt}
                maxLength={300}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={intl.formatMessage(messages.placeholder)}
                aria-label={intl.formatMessage(messages.heading)}
                className="!h-12 !rounded-xl !pl-11 !text-base"
                data-testid="ai-prompt"
              />
            </div>
            <Button
              type="submit"
              buttonType="primary"
              className="!h-12 !rounded-xl px-6"
              disabled={
                working || !me?.effective.available || (!prompt.trim() && !seed)
              }
            >
              <SparklesIcon className="mr-2 h-5 w-5" />
              <span>{intl.formatMessage(messages.find)}</span>
            </Button>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <SegmentedControl
              options={kindOptions}
              value={kind}
              onChange={setKind}
              ariaLabel={intl.formatMessage(messages.kindLabel)}
              size="sm"
            />
            {showSeed && !run ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-indigo-600/30 px-3 py-1 text-sm text-indigo-100 ring-1 ring-indigo-500">
                {intl.formatMessage(messages.moreLike, { title: seedName })}
                <button
                  type="button"
                  aria-label={intl.formatMessage(messages.clearSeed)}
                  onClick={() => setSearchParams(new URLSearchParams())}
                  className="ml-1 rounded-full p-0.5 hover:bg-indigo-500/40"
                >
                  <XMarkIcon className="h-4 w-4" />
                </button>
              </span>
            ) : null}
          </div>
        </form>

        {!run && !working ? (
          <div className="mt-5 flex flex-wrap gap-2">
            {MOODS.map((m) => (
              <Chip
                key={m.label}
                disabled={!me?.effective.available}
                onClick={() => {
                  const text = intl.formatMessage(messages[m.prompt]);
                  setPrompt(text);
                  void start(requestFor(text));
                }}
              >
                {intl.formatMessage(messages[m.label])}
              </Chip>
            ))}
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-400">
          {connectionLabel ? <span>{connectionLabel}</span> : null}
          {left !== null && usage?.dailyLimit != null ? (
            <span>
              {intl.formatMessage(messages.left, {
                left,
                limit: usage.dailyLimit,
              })}
            </span>
          ) : null}
          <Link to="/profile/settings/ai" className="hover:text-white">
            {intl.formatMessage(messages.tasteLink)} →
          </Link>
        </div>

        {error ? (
          <div className="mt-5">
            <Alert type="error" title={error.message}>
              {run?.stage === 'failed' ? (
                <Button buttonSize="sm" className="mt-2" onClick={retry}>
                  <ArrowPathIcon className="mr-1 h-4 w-4" />
                  <span>{intl.formatMessage(messages.tryAgain)}</span>
                </Button>
              ) : null}
            </Alert>
          </div>
        ) : null}
      </div>

      {working ? (
        <div className="mt-8" data-testid="ai-working">
          <div className="max-w-5xl">
            <StageSteps stage={run?.stage ?? 'planning'} />
          </div>
          <ul className="cards-vertical mt-6">
            {[...Array(12)].map((_, i) => (
              <li key={`ai-skeleton-${i}`}>
                <Placeholder canExpand />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {!working && run?.result ? (
        <div className="mt-8" data-testid="ai-results">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-xl font-bold text-white">
                {run.result.headline ||
                  run.request.prompt ||
                  (run.request.seed
                    ? intl.formatMessage(messages.moreLike, {
                        title: run.request.seed.title,
                      })
                    : '')}
              </h2>
              {run.result.summary ? (
                <p className="mt-1 text-sm text-gray-400">
                  {run.result.summary}
                </p>
              ) : null}
              <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-gray-500">
                <span>
                  {intl.formatMessage(messages.pickedFrom, {
                    picks: run.result.picks.length,
                    candidates: run.result.candidates,
                  })}
                </span>
                {run.result.usedWeb ? (
                  <span className="inline-flex items-center gap-1">
                    <GlobeAltIcon className="h-3.5 w-3.5" />
                    {intl.formatMessage(messages.usedWeb)}
                  </span>
                ) : null}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {hasPermission(Permission.ADMIN) &&
              run.request.prompt &&
              !run.request.seed ? (
                <Button buttonSize="sm" onClick={addToDiscover}>
                  <PlusIcon className="mr-1 h-4 w-4" />
                  <span>{intl.formatMessage(messages.addToDiscover)}</span>
                </Button>
              ) : null}
              <Button buttonSize="sm" onClick={retry}>
                <ArrowPathIcon className="mr-1 h-4 w-4" />
                <span>{intl.formatMessage(messages.tryAgain)}</span>
              </Button>
              <Button
                buttonSize="sm"
                buttonType="ghost"
                onClick={() => {
                  setPrompt('');
                  setSearchParams(new URLSearchParams());
                }}
              >
                {intl.formatMessage(messages.startOver)}
              </Button>
            </div>
          </div>

          {run.result.refinements.length > 0 ? (
            <div className="mb-5 flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-gray-300">
                {intl.formatMessage(messages.refine)}
              </span>
              {run.result.refinements.map((chip) => (
                <Chip key={chip} onClick={() => refine(chip)}>
                  {chip}
                </Chip>
              ))}
            </div>
          ) : null}

          <p className="mb-3 text-xs text-gray-500">
            {intl.formatMessage(messages.feedbackHint)}
          </p>
          <ul className="cards-vertical">
            {run.result.picks.map((pick) => (
              <li key={`${pick.mediaType}-${pick.tmdbId}`}>
                <AiPickCard pick={pick} onFeedback={onFeedback} canExpand />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {recent && recent.length > 0 ? (
        <div className="mt-10 max-w-5xl">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-300">
            <ClockIcon className="h-4 w-4" />
            {intl.formatMessage(messages.recent)}
          </h3>
          <div className="flex flex-wrap gap-2">
            {recent
              .filter(
                (r, i, all) =>
                  r.id !== runParam &&
                  r.stage === 'done' &&
                  // Only the latest run of each request.
                  all.findIndex(
                    (o) =>
                      o.stage === 'done' &&
                      o.prompt === r.prompt &&
                      o.seedTitle === r.seedTitle
                  ) === i
              )
              .slice(0, 10)
              .map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => {
                    const next = new URLSearchParams();
                    next.set('run', String(r.id));
                    setSearchParams(next);
                  }}
                  className="max-w-xs truncate rounded-lg border border-gray-700 bg-gray-800/60 px-3 py-1.5 text-left text-sm text-gray-300 hover:border-gray-500 hover:text-white"
                  title={r.headline ?? r.prompt}
                >
                  {r.prompt ||
                    (r.seedTitle
                      ? intl.formatMessage(messages.moreLike, {
                          title: r.seedTitle,
                        })
                      : (r.headline ?? ''))}
                </button>
              ))}
          </div>
        </div>
      ) : null}
    </>
  );
};

export default AiPicks;
