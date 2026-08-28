import Modal from '@app/components/Common/Modal';
import type { MappingGapRow } from '@app/components/Settings/SettingsMapping';
import useToasts from '@app/hooks/useToasts';
import { Transition } from '@headlessui/react';
import axios from 'axios';
import { useState } from 'react';

interface MappingRepairModalProps {
  gap: MappingGapRow;
  onClose: () => void;
  onResolved: () => void;
}

const TARGETS = [
  { value: 'tmdb_show', label: 'TMDB show' },
  { value: 'tmdb_movie', label: 'TMDB movie' },
  { value: 'tvdb_show', label: 'TVDB series' },
  { value: 'imdb', label: 'IMDB' },
];

/** A suggestion is stored as a ref key, e.g. `tmdb_show:1429:s2`. */
const parseSuggestion = (
  value?: string
): { namespace: string; id: string; season?: string } | undefined => {
  if (!value) return undefined;
  const [namespace, id, season] = value.split(':');
  if (!namespace || !id) return undefined;
  return { namespace, id, season: season?.replace(/^s/, '') };
};

const MappingRepairModal = ({
  gap,
  onClose,
  onResolved,
}: MappingRepairModalProps) => {
  const { addToast } = useToasts();
  const suggestion = parseSuggestion(gap.suggestedTarget);
  const [toNamespace, setToNamespace] = useState(
    suggestion?.namespace ??
      (gap.mediaType === 'movie' ? 'tmdb_movie' : 'tmdb_show')
  );
  const [toExternalId, setToExternalId] = useState('');
  const [toSeason, setToSeason] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (ignore: boolean) => {
    setSaving(true);
    try {
      await axios.post(`/api/v1/settings/mapping/gaps/${gap.id}/resolve`, {
        ignore,
        toNamespace,
        toExternalId: toExternalId.trim(),
        toSeason: toSeason.trim() === '' ? undefined : Number(toSeason),
        note: note.trim() || undefined,
      });
      addToast(ignore ? 'Gap ignored.' : 'Override saved.', {
        appearance: 'success',
        autoDismiss: true,
      });
      onResolved();
    } catch {
      addToast('Unable to save the mapping override.', {
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
        title="Fix mapping"
        subTitle={gap.title ?? `${gap.namespace}:${gap.externalId}`}
        onCancel={onClose}
        okText={saving ? 'Saving…' : 'Save override'}
        okDisabled={saving}
        onOk={() => submit(false)}
        secondaryText="Ignore"
        secondaryButtonType="warning"
        onSecondary={() => submit(true)}
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-300">
            Overrides sit above every resolver, including the graph. Leave the
            id empty to record that this item genuinely has no counterpart,
            which stops live resolvers re-asking on every render.
          </p>

          <div className="text-xs text-gray-400">
            Seen {gap.hitCount} time(s) · {gap.reason}
            {gap.discoverSource ? ` · ${gap.discoverSource}` : ''}
            {gap.rejectedTarget ? ` · rejected ${gap.rejectedTarget}` : ''}
          </div>

          {suggestion && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-200">
              <p>
                Unverified title match: <strong>{gap.suggestedTarget}</strong>
                {gap.suggestedConfidence != null
                  ? ` (score ${gap.suggestedConfidence})`
                  : ''}
                . It has not been written anywhere; check it before accepting.
              </p>
              <button
                type="button"
                className="mt-2 underline"
                onClick={() => {
                  setToNamespace(suggestion.namespace);
                  setToExternalId(suggestion.id);
                  setToSeason(suggestion.season ?? '');
                }}
              >
                Use this suggestion
              </button>
            </div>
          )}

          <label className="block text-sm font-medium text-gray-200">
            Target namespace
            <select
              value={toNamespace}
              onChange={(event) => setToNamespace(event.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-500 bg-gray-700 px-3 py-2 text-white"
            >
              {TARGETS.map((target) => (
                <option key={target.value} value={target.value}>
                  {target.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm font-medium text-gray-200">
            Target id
            <input
              value={toExternalId}
              placeholder="e.g. 1429"
              onChange={(event) => setToExternalId(event.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-500 bg-gray-700 px-3 py-2 text-white"
            />
          </label>

          <label className="block text-sm font-medium text-gray-200">
            Target season (optional)
            <input
              value={toSeason}
              inputMode="numeric"
              onChange={(event) => setToSeason(event.target.value)}
              className="mt-1 block w-full rounded-md border border-gray-500 bg-gray-700 px-3 py-2 text-white"
            />
          </label>

          <label className="block text-sm font-medium text-gray-200">
            Note (optional)
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

export default MappingRepairModal;
