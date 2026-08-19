import ExternalIntegrationCards from '@app/components/Settings/ExternalIntegrationCards';
import SettingsServices from '@app/components/Settings/SettingsServices';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Setup.SetupIntegrations', {
  title: 'Connect your integrations',
  description:
    'Add request services now, and optionally connect Trakt, AniList, and MDBList. You can change any of these later in Settings.',
  optionalIntegrations: 'Optional discovery and rating services',
  requestServices: 'Request services',
});

const SetupIntegrations = () => {
  const intl = useIntl();

  return (
    <div>
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.title)}</h3>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>

      <div className="mb-6 mt-8">
        <h3 className="heading">
          {intl.formatMessage(messages.optionalIntegrations)}
        </h3>
      </div>
      <ExternalIntegrationCards />

      <div className="mt-10 border-t border-gray-600 pt-8">
        <h3 className="heading">
          {intl.formatMessage(messages.requestServices)}
        </h3>
        <div className="mt-8">
          <SettingsServices />
        </div>
      </div>
    </div>
  );
};

export default SetupIntegrations;
