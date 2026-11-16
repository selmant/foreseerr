import TitleCard from '@app/components/TitleCard';
import defineMessages from '@app/utils/defineMessages';
import {
  CloseButton,
  Popover,
  PopoverButton,
  PopoverPanel,
} from '@headlessui/react';
import {
  EyeIcon,
  HandThumbDownIcon,
  HandThumbUpIcon,
  LightBulbIcon,
  NoSymbolIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import type { AiPick, AiVerdict } from '@shared/interfaces/api/aiInterfaces';
import type { MovieResult, TvResult } from '@shared/models/Search';
import {
  useCallback,
  useState,
  type ComponentType,
  type SVGProps,
} from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Ai.AiPickCard', {
  tip: 'Why it was picked',
  whyTitle: 'Why it’s here',
  open: 'Why {title} was picked, and feedback',
  close: 'Close',
  feedback: 'Your feedback',
  like: 'Like',
  dislike: 'Not for me',
  seen: 'Seen it',
  notInterested: 'Don’t suggest',
  scope: 'Only tunes AI picks; trackers aren’t changed.',
});

const VERDICTS: {
  kind: AiVerdict;
  label: keyof typeof messages;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Badge colour once chosen. */
  tone: string;
}[] = [
  {
    kind: 'like',
    label: 'like',
    Icon: HandThumbUpIcon,
    tone: 'text-green-400',
  },
  {
    kind: 'dislike',
    label: 'dislike',
    Icon: HandThumbDownIcon,
    tone: 'text-red-400',
  },
  { kind: 'seen', label: 'seen', Icon: EyeIcon, tone: 'text-indigo-300' },
  {
    kind: 'not_interested',
    label: 'notInterested',
    Icon: NoSymbolIcon,
    tone: 'text-gray-300',
  },
];

interface AiPickCardProps {
  pick: AiPick;
  /** Without it, the popover only explains the pick. */
  onFeedback?: (pick: AiPick, kind: AiVerdict | null) => void | Promise<void>;
  /** Fill the grid cell instead of the slider width. */
  canExpand?: boolean;
}

/**
 * A pick as the app's usual poster. Like the rating badge, a small lightbulb
 * badge shows on hover or tap; it opens a popover with the one-line reason
 * and feedback. Once rated, the badge stays visible with the rating.
 */
const AiPickCard = ({ pick, onFeedback, canExpand }: AiPickCardProps) => {
  const intl = useIntl();
  const [saving, setSaving] = useState(false);
  // Headless UI's `focus` prop focuses the panel before it is anchored, so the
  // browser scrolls to the panel's unpositioned spot (the top of the page) and
  // the opened popover ends up off screen. Focus it without scrolling instead.
  const focusOnOpen = useCallback((el: HTMLButtonElement | null) => {
    el?.focus({ preventScroll: true });
  }, []);
  const item = pick.item as unknown as MovieResult | TvResult;
  const isMovie = pick.mediaType === 'movie';
  const title = isMovie ? (item as MovieResult).title : (item as TvResult).name;
  const chosen = VERDICTS.find((v) => v.kind === pick.feedback);
  const passed =
    pick.feedback === 'dislike' || pick.feedback === 'not_interested';

  const give = async (kind: AiVerdict) => {
    if (saving || !onFeedback) return;
    setSaving(true);
    try {
      await onFeedback(pick, pick.feedback === kind ? null : kind);
    } finally {
      setSaving(false);
    }
  };

  const badge = (shown: boolean) =>
    shown || chosen ? (
      <Popover>
        <PopoverButton
          aria-label={intl.formatMessage(messages.open, { title })}
          title={intl.formatMessage(messages.tip)}
          className="inline-flex items-center gap-1 rounded-lg border border-gray-600/70 bg-gray-800/85 px-2 py-1 text-[0.7rem] font-semibold leading-none text-white shadow-md backdrop-blur-[2px] transition hover:border-indigo-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 data-[open]:border-indigo-400"
        >
          {chosen ? (
            <>
              <chosen.Icon className={`h-3.5 w-3.5 ${chosen.tone}`} />
              <span>{intl.formatMessage(messages[chosen.label])}</span>
            </>
          ) : (
            <LightBulbIcon className="h-3.5 w-3.5 text-amber-300" />
          )}
        </PopoverButton>
        <PopoverPanel
          anchor={{ to: 'bottom start', gap: 6, padding: 8 }}
          role="dialog"
          aria-label={intl.formatMessage(messages.whyTitle)}
          className="z-[100] w-72 max-w-[calc(100vw-16px)] rounded-xl border border-gray-600/80 bg-gray-900/95 p-3 shadow-2xl backdrop-blur-sm focus:outline-none"
        >
          <div className="flex items-start gap-2">
            <LightBulbIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <div className="min-w-0 flex-1">
              <div className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
                {intl.formatMessage(messages.whyTitle)}
              </div>
              <p className="mt-1 text-sm leading-relaxed text-gray-100">
                {pick.why}
              </p>
            </div>
            <CloseButton
              ref={focusOnOpen}
              aria-label={intl.formatMessage(messages.close)}
              className="-mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-800 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
            >
              <XMarkIcon className="h-4 w-4" />
            </CloseButton>
          </div>
          {onFeedback ? (
            <>
              <div
                role="group"
                aria-label={intl.formatMessage(messages.feedback)}
                aria-busy={saving}
                className="mt-3 grid grid-cols-2 gap-1.5"
              >
                {VERDICTS.map(({ kind, label, Icon }) => {
                  const on = pick.feedback === kind;
                  return (
                    <button
                      key={kind}
                      type="button"
                      aria-pressed={on}
                      disabled={saving}
                      onClick={() => void give(kind)}
                      className={`flex min-h-10 items-center gap-2 rounded-lg px-2.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:cursor-wait disabled:opacity-60 ${
                        on
                          ? 'bg-indigo-600 text-white'
                          : 'bg-gray-800 text-gray-200 hover:bg-gray-700 hover:text-white'
                      }`}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="truncate">
                        {intl.formatMessage(messages[label])}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-2 text-center text-[11px] text-gray-500">
                {intl.formatMessage(messages.scope)}
              </p>
            </>
          ) : null}
        </PopoverPanel>
      </Popover>
    ) : null;

  return (
    <div
      className={`${canExpand ? 'w-full' : 'w-36 sm:w-36 md:w-44'} transition ${passed ? 'opacity-50' : ''}`}
      data-testid="ai-pick"
    >
      <TitleCard
        id={pick.tmdbId}
        isAddedToWatchlist={item.mediaInfo?.watchlists?.length ?? 0}
        image={item.posterPath}
        status={item.mediaInfo?.status}
        summary={item.overview}
        title={title}
        userScore={item.voteAverage}
        ratings={item.ratings}
        year={
          isMovie
            ? (item as MovieResult).releaseDate
            : (item as TvResult).firstAirDate
        }
        mediaType={pick.mediaType}
        inProgress={(item.mediaInfo?.downloadStatus ?? []).length > 0}
        canExpand={canExpand}
        extraBadge={badge}
      />
    </div>
  );
};

export default AiPickCard;
