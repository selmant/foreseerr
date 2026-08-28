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
    'This correction overrides every automatic resolver. Leave the id empty to record that no counterpart exists, which stops repeated lookups.',
  targetType: 'Target type',
  movie: 'TMDB movie',
  tv: 'TMDB show',
  tmdbId: 'TMDB id',
  note: 'Note (optional)',
  save: 'Save override',
  saved: 'Mapping override saved.',
  failed: 'Unable to save the mapping override.',
});

interface FixMappingModalProps {
  title: string;
  mediaType: 'movie' | 'tv';
  namespace: string;
  externalId: string;
  season?: number;
  onClose: () => void;
}

const FixMappingModal = ({
  title,
  mediaType,
  namespace,
  externalId,
  season,
  onClose,
}: FixMappingModalProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [target, setTarget] = useState(
    mediaType === 'movie' ? 'tmdb_movie' : 'tmdb_show'
  );
  const [tmdbId, setTmdbId] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await axios.post('/api/v1/settings/mapping/overrides', {
        fromNamespace: namespace,
        fromExternalId: externalId,
        fromSeason: season,
        toNamespace: target,
        toExternalId: tmdbId.trim(),
        note: note.trim() || undefined,
      });
      addToast(intl.formatMessage(messages.saved), {
        appearance: 'success',
        autoDismiss: true,
      });
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
        okDisabled={saving}
        onOk={save}
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-300">
            {intl.formatMessage(messages.explanation)}
          </p>
          <label className="block text-sm font-medium text-gray-200">
            {intl.formatMessage(messages.targetType)}
            <select
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-500 bg-gray-700 px-3 py-2 text-white"
            >
              <option value="tmdb_movie">
                {intl.formatMessage(messages.movie)}
              </option>
              <option value="tmdb_show">
                {intl.formatMessage(messages.tv)}
              </option>
            </select>
          </label>
          <label className="block text-sm font-medium text-gray-200">
            {intl.formatMessage(messages.tmdbId)}
            <input
              value={tmdbId}
              inputMode="numeric"
              onChange={(event) => setTmdbId(event.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-500 bg-gray-700 px-3 py-2 text-white"
            />
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
