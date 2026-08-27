import Button from '@app/components/Common/Button';
import useToasts from '@app/hooks/useToasts';
import axios from 'axios';
import { useEffect, useState } from 'react';

type SimklSettings = {
  clientId: string;
  actionsEnabled: boolean;
  showCommunityRating: boolean;
  posterCommunityRating: boolean;
  linkedAccountCount: number;
};

const SettingsSimkl = ({ onSave }: { onSave: () => void }) => {
  const { addToast } = useToasts();
  const [values, setValues] = useState<SimklSettings>({
    clientId: '',
    actionsEnabled: true,
    showCommunityRating: true,
    posterCommunityRating: false,
    linkedAccountCount: 0,
  });
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    axios
      .get<SimklSettings>('/api/v1/settings/simkl')
      .then(({ data }) => setValues(data))
      .catch(() =>
        addToast('Unable to load Simkl settings.', {
          appearance: 'error',
          autoDismiss: true,
        })
      )
      .finally(() => setLoading(false));
  }, [addToast]);
  const save = async () => {
    try {
      await axios.post('/api/v1/settings/simkl', values);
      addToast('Simkl settings saved.', {
        appearance: 'success',
        autoDismiss: true,
      });
      onSave();
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? error.response?.data?.message
        : 'Unable to save Simkl settings.';
      addToast(message, { appearance: 'error', autoDismiss: true });
    }
  };
  return (
    <div className="space-y-4 p-1">
      <p className="text-sm text-gray-300">
        Create an application at simkl.com/settings/developer, then enter its
        public Client ID. Simkl uses PIN linking and does not require a client
        secret.
      </p>
      <label className="block text-sm font-medium text-gray-200">
        Client ID
        <input
          value={values.clientId}
          disabled={loading}
          onChange={(event) =>
            setValues({ ...values, clientId: event.target.value })
          }
          className="mt-1 block w-full rounded-md border border-gray-500 bg-gray-700 px-3 py-2 text-white"
        />
      </label>
      <label className="flex gap-2 text-sm text-gray-200">
        <input
          type="checkbox"
          checked={values.actionsEnabled}
          onChange={(event) =>
            setValues({ ...values, actionsEnabled: event.target.checked })
          }
        />
        Enable watched and rating actions
      </label>
      <label className="flex gap-2 text-sm text-gray-200">
        <input
          type="checkbox"
          checked={values.showCommunityRating}
          onChange={(event) =>
            setValues({ ...values, showCommunityRating: event.target.checked })
          }
        />
        Show community ratings on details
      </label>
      <label className="flex gap-2 text-sm text-gray-200">
        <input
          type="checkbox"
          checked={values.posterCommunityRating}
          onChange={(event) =>
            setValues({
              ...values,
              posterCommunityRating: event.target.checked,
            })
          }
        />
        Show community ratings on posters
      </label>
      <Button buttonType="primary" onClick={save} disabled={loading}>
        Save
      </Button>
    </div>
  );
};

export default SettingsSimkl;
