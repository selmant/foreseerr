import JellyfinLogo from '@app/assets/services/jellyfin-icon.svg';
import Button from '@app/components/Common/Button';
import defineMessages from '@app/utils/defineMessages';
import { jellyfinWebPath } from '@app/utils/publicBasePath';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Login.PluginLogin', {
  title: 'Sign in with Jellyfin',
  description:
    '{applicationTitle} uses your Jellyfin sign-in. Sign in to Jellyfin in this browser, then open {applicationTitle} from Jellyfin or try again.',
  openJellyfin: 'Open Jellyfin',
  tryAgain: 'Try Again',
});

interface PluginLoginProps {
  applicationTitle: string;
}

/**
 * The Jellyfin plugin signs users in before the app loads, so this page only
 * shows when the Jellyfin session has ended. Reloading lets the plugin retry.
 */
const PluginLogin = ({ applicationTitle }: PluginLoginProps) => {
  const intl = useIntl();

  return (
    <div className="space-y-6 text-center" data-testid="plugin-login">
      <h2 className="text-lg font-bold text-neutral-200">
        {intl.formatMessage(messages.title)}
      </h2>
      <p className="text-sm text-gray-300">
        {intl.formatMessage(messages.description, { applicationTitle })}
      </p>
      <div className="flex flex-col gap-2">
        <Button as="a" buttonType="primary" href={jellyfinWebPath()}>
          <JellyfinLogo />
          <span>{intl.formatMessage(messages.openJellyfin)}</span>
        </Button>
        <Button
          buttonType="ghost"
          type="button"
          onClick={() => window.location.reload()}
        >
          <ArrowPathIcon />
          <span>{intl.formatMessage(messages.tryAgain)}</span>
        </Button>
      </div>
    </div>
  );
};

export default PluginLogin;
