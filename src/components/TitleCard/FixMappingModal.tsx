import Modal from '@app/components/Common/Modal';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.TitleCard.FixMappingModal', {
  title: 'Fix mapping',
  explanation:
    'A correction wins over every automatic match. Leave the id empty to record that this title has no TMDB entry, which stops repeated lookups.',
  targetType: 'Target type',
  movie: 'TMDB movie',
  tv: 'TMDB show',
  tmdbId: 'TMDB id or link',
  invalidId: 'Enter a TMDB id or a themoviedb.org link, or leave it empty.',
  note: 'Note (optional)',
  save: 'Save correction',
  saved: 'Mapping correction saved.',
  failed: 'Unable to save the mapping correction.',
});

interface FixMappingModalProps {
  title: string;
  mediaType?: 'movie' | 'tv';
  namespace: string;
  externalId: string;
  /** Pre-filled TMDB id, e.g. when correcting a guess. */
  tmdbId?: number | null;
  onClose: () => void;
  onSaved?: () => void;
}

/**
 * A bare id, or a themoviedb.org link whose path also says movie or show.
 * Anything else is a typo, and saving it would hide the title for good.
 */
const parseTmdbInput = (
  value: string
): { id?: number; type?: 'movie' | 'tv' } | undefined => {
  const text = value.trim();
  if (!text) return {};
  if (/^\d+$/.test(text))
    return Number(text) > 0 ? { id: Number(text) } : undefined;
  const link = text.match(/themoviedb\.org\/(?:[a-z-]+\/)?(movie|tv)\/(\d+)/i);
  return link
    ? { id: Number(link[2]), type: link[1].toLowerCase() as 'movie' | 'tv' }
    : undefined;
};

const FixMappingModal = ({
  title,
  mediaType,
  namespace,
  externalId,
  tmdbId: initialTmdbId,
  onClose,
  onSaved,
}: FixMappingModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [target, setTarget] = useState<'movie' | 'tv'>(
    mediaType === 'movie' ? 'movie' : 'tv'
  );
  const [tmdbId, setTmdbId] = useState(
    initialTmdbId ? String(initialTmdbId) : ''
  );
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const parsed = parseTmdbInput(tmdbId);

  const save = async () => {
    if (!parsed) return;
    setSaving(true);
    try {
      await axios.post('/api/v1/settings/mapping/corrections', {
        srcNs: namespace,
        srcId: externalId,
        ...(parsed.id
          ? { tmdbId: parsed.id, tmdbType: parsed.type ?? target }
          : {}),
        note: note.trim() || undefined,
      });
      addToast(intl.formatMessage(messages.saved), {
        appearance: 'success',
        autoDismiss: true,
      });
      onSaved?.();
      onClose();
    } catch {
      addToast(intl.formatMessage(messages.failed), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Transition
      as="div"
      appear
      show
      enter="transition ease-in-out duration-300 transform opacity-0"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition ease-in-out duration-300 transform opacity-100"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
    >
      <Modal
        title={intl.formatMessage(messages.title)}
        subTitle={`${title} · ${namespace}:${externalId}`}
        onCancel={onClose}
        okText={intl.formatMessage(messages.save)}
        okDisabled={saving || !parsed}
        onOk={save}
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-300">
            {intl.formatMessage(messages.explanation)}
          </p>
          <label className="block text-sm font-medium text-gray-200">
            {intl.formatMessage(messages.targetType)}
            <select
              value={parsed?.type ?? target}
              disabled={Boolean(parsed?.type)}
              onChange={(event) =>
                setTarget(event.target.value === 'movie' ? 'movie' : 'tv')
              }
              className="mt-1 block w-full rounded-md border border-gray-500 bg-gray-700 px-3 py-2 text-white"
            >
              <option value="movie">
                {intl.formatMessage(messages.movie)}
              </option>
              <option value="tv">{intl.formatMessage(messages.tv)}</option>
            </select>
          </label>
          <label className="block text-sm font-medium text-gray-200">
            {intl.formatMessage(messages.tmdbId)}
            <input
              value={tmdbId}
              placeholder="1429 or https://www.themoviedb.org/tv/1429"
              onChange={(event) => setTmdbId(event.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-500 bg-gray-700 px-3 py-2 text-white"
            />
            {!parsed && (
              <span className="mt-1 block text-xs text-red-400">
                {intl.formatMessage(messages.invalidId)}
              </span>
            )}
          </label>
          <label className="block text-sm font-medium text-gray-200">
            {intl.formatMessage(messages.note)}
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-500 bg-gray-700 px-3 py-2 text-white"
            />
          </label>
        </div>
      </Modal>
    </Transition>
  );
};

export default FixMappingModal;
