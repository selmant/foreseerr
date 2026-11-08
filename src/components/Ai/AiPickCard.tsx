import Button from '@app/components/Common/Button';
import Modal from '@app/components/Common/Modal';
import TitleCard from '@app/components/TitleCard';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import {
  CheckIcon,
  EyeIcon,
  HandThumbDownIcon,
  HandThumbUpIcon,
  InformationCircleIcon,
  NoSymbolIcon,
} from '@heroicons/react/24/outline';
import type { AiPick, AiVerdict } from '@shared/interfaces/api/aiInterfaces';
import type { MovieResult, TvResult } from '@shared/models/Search';
import { Fragment, useState, type ComponentType, type SVGProps } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Ai.AiPickCard', {
  why: 'Why this pick?',
  openReason: 'Why this pick? {title}',
  feedback: 'Tune your recommendations',
  feedbackHint: 'Choose one; select it again to undo.',
  feedbackScope:
    'This shapes AI suggestions. It does not change your tracker ratings or watch status.',
  like: 'More like this',
  dislike: 'Not for me',
  seen: 'Already seen',
  notInterested: 'Don’t suggest this',
  close: 'Close',
});

const VERDICTS: {
  kind: AiVerdict;
  label: keyof typeof messages;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
}[] = [
  { kind: 'like', label: 'like', Icon: HandThumbUpIcon },
  { kind: 'dislike', label: 'dislike', Icon: HandThumbDownIcon },
  { kind: 'seen', label: 'seen', Icon: EyeIcon },
  { kind: 'not_interested', label: 'notInterested', Icon: NoSymbolIcon },
];

interface AiPickCardProps {
  pick: AiPick;
  onFeedback: (pick: AiPick, kind: AiVerdict | null) => void | Promise<void>;
  /** Fill the grid cell instead of the fixed slider width. */
  canExpand?: boolean;
}

/** A standard poster, with recommendation context and feedback in a dialog. */
const AiPickCard = ({ pick, onFeedback, canExpand }: AiPickCardProps) => {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const item = pick.item as unknown as MovieResult | TvResult;
  const isMovie = pick.mediaType === 'movie';
  const title = isMovie ? (item as MovieResult).title : (item as TvResult).name;
  const selectedVerdict = VERDICTS.find((v) => v.kind === pick.feedback);

  const giveFeedback = async (kind: AiVerdict) => {
    if (saving) return;
    setSaving(true);
    try {
      await onFeedback(pick, pick.feedback === kind ? null : kind);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={`flex flex-col ${canExpand ? 'w-full' : 'w-36 sm:w-36 md:w-44'}`}
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
        year={
          isMovie
            ? (item as MovieResult).releaseDate
            : (item as TvResult).firstAirDate
        }
        mediaType={pick.mediaType}
        inProgress={(item.mediaInfo?.downloadStatus ?? []).length > 0}
        canExpand={canExpand}
      />
      <button
        type="button"
        aria-label={intl.formatMessage(messages.openReason, { title })}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="mt-1 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg px-1 text-xs text-gray-400 transition hover:bg-gray-800 hover:text-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        {selectedVerdict ? (
          <CheckIcon className="h-4 w-4 shrink-0 text-indigo-300" />
        ) : (
          <InformationCircleIcon className="h-4 w-4 shrink-0" />
        )}
        <span className="truncate">
          {intl.formatMessage(
            selectedVerdict ? messages[selectedVerdict.label] : messages.why
          )}
        </span>
      </button>
      <Transition as={Fragment} show={open}>
        <Modal
          title={title}
          subTitle={intl.formatMessage(messages.why)}
          onCancel={() => setOpen(false)}
          cancelText={intl.formatMessage(messages.close)}
          stickyActions
        >
          <p className="whitespace-pre-line text-base leading-relaxed text-gray-200">
            {pick.why}
          </p>
          <div className="mt-6 border-t border-gray-700 pt-4">
            <h3 className="text-sm font-semibold text-gray-100">
              {intl.formatMessage(messages.feedback)}
            </h3>
            <p className="mt-1 text-xs text-gray-400">
              {intl.formatMessage(messages.feedbackHint)}
            </p>
            <div
              className="mt-3 space-y-1"
              role="group"
              aria-label={intl.formatMessage(messages.feedback)}
              aria-busy={saving}
            >
              {VERDICTS.map(({ kind, label, Icon }) => {
                const selected = pick.feedback === kind;
                return (
                  <Button
                    key={kind}
                    type="button"
                    buttonType="ghost"
                    disabled={saving}
                    aria-pressed={selected}
                    onClick={() => void giveFeedback(kind)}
                    className={`min-h-11 w-full !justify-start !border-transparent [&>span]:w-full ${selected ? '!bg-gray-700 !text-white' : '!text-gray-300'}`}
                  >
                    <Icon className="mr-3 h-5 w-5 shrink-0" />
                    <span className="flex-1 text-left">
                      {intl.formatMessage(messages[label])}
                    </span>
                    {selected ? (
                      <CheckIcon className="ml-3 h-4 w-4 shrink-0 text-indigo-300" />
                    ) : null}
                  </Button>
                );
              })}
            </div>
            <p className="mt-4 text-xs leading-relaxed text-gray-400">
              {intl.formatMessage(messages.feedbackScope)}
            </p>
          </div>
        </Modal>
      </Transition>
    </div>
  );
};

export default AiPickCard;
