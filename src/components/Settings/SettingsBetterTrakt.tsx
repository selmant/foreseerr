import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import axios from 'axios';
import { useIntl } from 'react-intl';
import useSWR, { mutate as globalMutate } from 'swr';

const messages = defineMessages('components.Settings.SettingsBetterTrakt', {
  title: 'Better Trakt through Jellyfin',
  description:
    'Use your users’ linked Jellyfin accounts instead of registering a separate Trakt application. This is recommended when Trakt app-registration limits block the normal setup, but it needs a little more server setup.',
  setup: 'Setup checklist',
  plugin: 'Install Better Trakt 1000.2026.731.3 or newer in Jellyfin.',
  pluginLink: 'Open Better Trakt releases',
  user: 'Each user links Trakt in Better Trakt and refreshes their Jellyfin session in Foreseer if asked.',
  admin:
    'An administrator enables Foreseer access for the relevant Better Trakt users.',
  security:
    'Foreseer requests a short-lived access token when needed; it never stores a Trakt refresh token.',
  enable: 'Use Better Trakt',
  active: 'Better Trakt is active',
  success: 'Better Trakt is now active.',
  failure: 'Unable to enable Better Trakt.',
});

type TraktSettingsResponse = {
  provider: 'direct' | 'jellyfin';
  clientId: string;
  actionsEnabled: boolean;
};

const SettingsBetterTrakt = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<TraktSettingsResponse>(
    '/api/v1/settings/trakt'
  );

  if (!data && !error) return <LoadingSpinner />;

  const enable = async () => {
    try {
      await axios.post('/api/v1/settings/trakt', {
        provider: 'jellyfin',
        clientId: data?.clientId ?? '',
        clientSecret: '',
        actionsEnabled: data?.actionsEnabled !== false,
      });
      addToast(intl.formatMessage(messages.success), {
        autoDismiss: true,
        appearance: 'success',
      });
      await mutate();
      await globalMutate('/api/v1/settings/public');
    } catch {
      addToast(intl.formatMessage(messages.failure), {
        autoDismiss: true,
        appearance: 'error',
      });
    }
  };

  return (
    <>
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.title)}</h3>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>
      <Alert type="info" title={intl.formatMessage(messages.security)} />
      <div className="section">
        <h4 className="text-lg font-semibold">
          {intl.formatMessage(messages.setup)}
        </h4>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-gray-300">
          <li>
            {intl.formatMessage(messages.plugin)}{' '}
            <a
              href="https://github.com/selmant/better-trakt/releases"
              target="_blank"
              rel="noreferrer"
              className="text-white underline"
            >
              {intl.formatMessage(messages.pluginLink)}
            </a>
          </li>
          <li>{intl.formatMessage(messages.user)}</li>
          <li>{intl.formatMessage(messages.admin)}</li>
        </ol>
      </div>
      <div className="mt-6">
        <Button
          buttonType="primary"
          onClick={enable}
          disabled={data?.provider === 'jellyfin'}
        >
          {intl.formatMessage(
            data?.provider === 'jellyfin' ? messages.active : messages.enable
          )}
        </Button>
      </div>
    </>
  );
};

export default SettingsBetterTrakt;
