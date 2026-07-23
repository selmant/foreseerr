import ExternalIntegrationCards from '@app/components/Settings/ExternalIntegrationCards';
import SettingsServices from '@app/components/Settings/SettingsServices';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Settings.SettingsIntegrations', {
  integrations: 'Integrations',
  description:
    'Connect the external services Foreseerr uses for requests, personalized discovery, and enriched ratings.',
  discoveryAndRatings: 'Discovery & Ratings',
  discoveryAndRatingsDescription:
    'Configure optional services that enrich discovery and title information.',
});

const SettingsIntegrations = () => {
  const intl = useIntl();

  return (
    <>
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.integrations)}</h3>
        <p className="description">
          {intl.formatMessage(messages.description)}
        </p>
      </div>

      <div className="mb-6 mt-10">
        <h3 className="heading">
          {intl.formatMessage(messages.discoveryAndRatings)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.discoveryAndRatingsDescription)}
        </p>
      </div>
      <div className="section">
        <ExternalIntegrationCards />
      </div>

      <div className="mt-12 border-t border-gray-600 pt-10">
        <SettingsServices />
      </div>
    </>
  );
};

export default SettingsIntegrations;
