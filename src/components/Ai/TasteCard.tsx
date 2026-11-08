import { aiErrorOf } from '@app/components/Ai/aiError';
import Button from '@app/components/Common/Button';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  EyeIcon,
  HandThumbDownIcon,
  HandThumbUpIcon,
  NoSymbolIcon,
  PencilIcon,
} from '@heroicons/react/24/outline';
import type {
  AiFeedbackItem,
  AiTaste,
  AiVerdict,
} from '@shared/interfaces/api/aiInterfaces';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import { Link } from 'react-router';
import useSWR from 'swr';

const messages = defineMessages('components.Ai.TasteCard', {
  title: 'Your taste card',
  hint: 'A short note about what you enjoy. AI Picks reads it with every request, and Foreseerr rewrites it as you rate picks. You can edit it.',
  empty:
    'Nothing yet. Rate a few picks in AI Picks, or write a few lines yourself.',
  updated: 'Updated {date}',
  edit: 'Edit',
  save: 'Save',
  cancel: 'Cancel',
  clear: 'Clear',
  clearConfirm: 'Clear the card?',
  placeholder:
    'e.g. Loves slow-burn sci-fi and found-family stories. Not into horror or reality TV.',
  feedbackCount:
    '{count, plural, =0 {No ratings yet} one {# rating} other {# ratings}}',
  pending:
    '{count, plural, one {# new rating} other {# new ratings}} will update the card after your next request.',
  forget: 'Forget all ratings',
  forgetConfirm: 'Forget all ratings?',
  recent: 'Recent ratings',
  openPicks: 'Open AI Picks',
  saved: 'Taste card saved.',
  forgotten: 'All ratings forgotten.',
});

const VERDICT_ICON: Record<AiVerdict, typeof HandThumbUpIcon> = {
  like: HandThumbUpIcon,
  dislike: HandThumbDownIcon,
  seen: EyeIcon,
  not_interested: NoSymbolIcon,
};

const VERDICT_COLOR: Record<AiVerdict, string> = {
  like: 'text-green-400',
  dislike: 'text-red-400',
  seen: 'text-indigo-300',
  not_interested: 'text-gray-400',
};

const MAX_CHARS = 1200;

/** The learned taste card, editable, with the ratings it learns from. */
const TasteCard = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data: taste, mutate } = useSWR<AiTaste>('/api/v1/ai/taste');
  const { data: feedback, mutate: mutateFeedback } = useSWR<AiFeedbackItem[]>(
    '/api/v1/ai/feedback'
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown) =>
    addToast(aiErrorOf(e, intl.formatMessage(globalMessages.error)).message, {
      appearance: 'error',
      autoDismiss: true,
    });

  const save = async (card: string) => {
    setBusy(true);
    try {
      const res = await axios.put<AiTaste>('/api/v1/ai/taste', { card });
      mutate(res.data, { revalidate: false });
      setEditing(false);
      addToast(intl.formatMessage(messages.saved), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    setBusy(true);
    try {
      const res = await axios.delete<AiTaste>('/api/v1/ai/feedback');
      mutate(res.data, { revalidate: false });
      mutateFeedback([], { revalidate: false });
      addToast(intl.formatMessage(messages.forgotten), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="rounded-xl border border-gray-700 bg-gray-800/40 p-4 sm:p-6"
      data-testid="ai-taste"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-lg font-semibold text-white">
            {intl.formatMessage(messages.title)}
          </h4>
          <p className="mt-1 max-w-3xl text-sm text-gray-400">
            {intl.formatMessage(messages.hint)}
          </p>
        </div>
        {!editing ? (
          <div className="flex gap-2">
            <Button
              buttonSize="sm"
              disabled={!taste || busy}
              onClick={() => {
                setDraft(taste?.card ?? '');
                setEditing(true);
              }}
            >
              <PencilIcon className="mr-1 h-4 w-4" />
              <span>{intl.formatMessage(messages.edit)}</span>
            </Button>
            {taste?.card ? (
              <ConfirmButton
                onClick={() => save('')}
                confirmText={intl.formatMessage(messages.clearConfirm)}
                disabled={busy}
              >
                {intl.formatMessage(messages.clear)}
              </ConfirmButton>
            ) : null}
          </div>
        ) : null}
      </div>

      {editing ? (
        <div className="mt-4">
          <textarea
            value={draft}
            maxLength={MAX_CHARS}
            rows={5}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={intl.formatMessage(messages.placeholder)}
            aria-label={intl.formatMessage(messages.title)}
            className="w-full"
          />
          <div className="mt-2 flex items-center gap-2">
            <Button
              buttonType="primary"
              buttonSize="sm"
              disabled={busy}
              onClick={() => save(draft)}
            >
              {intl.formatMessage(messages.save)}
            </Button>
            <Button
              buttonSize="sm"
              buttonType="ghost"
              disabled={busy}
              onClick={() => setEditing(false)}
            >
              {intl.formatMessage(messages.cancel)}
            </Button>
            <span className="ml-auto text-xs text-gray-500">
              {draft.length}/{MAX_CHARS}
            </span>
          </div>
        </div>
      ) : (
        <div className="mt-4 whitespace-pre-line rounded-lg bg-gray-900/60 p-4 text-sm leading-relaxed text-gray-200 ring-1 ring-gray-700">
          {taste?.card || (
            <span className="text-gray-500">
              {intl.formatMessage(messages.empty)}{' '}
              <Link to="/discover/ai" className="text-indigo-300 underline">
                {intl.formatMessage(messages.openPicks)}
              </Link>
            </span>
          )}
        </div>
      )}

      {taste ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-400">
          <span>
            {intl.formatMessage(messages.feedbackCount, {
              count: taste.feedbackCount,
            })}
          </span>
          {taste.updatedAt ? (
            <span>
              {intl.formatMessage(messages.updated, {
                date: intl.formatDate(taste.updatedAt, { dateStyle: 'medium' }),
              })}
            </span>
          ) : null}
          {taste.pendingFeedback > 0 ? (
            <span>
              {intl.formatMessage(messages.pending, {
                count: taste.pendingFeedback,
              })}
            </span>
          ) : null}
        </div>
      ) : null}

      {feedback && feedback.length > 0 ? (
        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h5 className="text-sm font-semibold text-gray-300">
              {intl.formatMessage(messages.recent)}
            </h5>
            <ConfirmButton
              onClick={forget}
              confirmText={intl.formatMessage(messages.forgetConfirm)}
              disabled={busy}
            >
              {intl.formatMessage(messages.forget)}
            </ConfirmButton>
          </div>
          <ul className="flex flex-wrap gap-2">
            {feedback.slice(0, 30).map((f) => {
              const Icon = VERDICT_ICON[f.kind];
              return (
                <li key={`${f.mediaType}-${f.tmdbId}`}>
                  <Link
                    to={`/${f.mediaType}/${f.tmdbId}`}
                    className="inline-flex max-w-[16rem] items-center gap-1.5 rounded-full border border-gray-700 bg-gray-800/70 px-3 py-1 text-xs text-gray-300 hover:border-gray-500 hover:text-white"
                  >
                    <Icon
                      className={`h-3.5 w-3.5 shrink-0 ${VERDICT_COLOR[f.kind]}`}
                    />
                    <span className="truncate">
                      {f.title || `${f.mediaType} ${f.tmdbId}`}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
};

export default TasteCard;
