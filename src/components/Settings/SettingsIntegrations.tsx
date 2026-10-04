import LinkButton from '@app/components/Common/LinkButton';
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
  accountHint:
    'These integrations apply to everyone. Connect your own accounts in Linked accounts to get personal recommendations and lists.',
  linkedAccounts: 'Linked accounts',
  jumpTo: 'Integration sections',
  radarr: 'Radarr',
  sonarr: 'Sonarr',
  overrideRules: 'Override rules',
  cleanup: 'Queue cleanup',
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

      <nav
        aria-label={intl.formatMessage(messages.jumpTo)}
        className="mb-6 flex flex-wrap gap-2"
      >
        {[
          { id: 'discovery-integrations', label: messages.discoveryAndRatings },
          { id: 'radarr-settings', label: messages.radarr },
          { id: 'sonarr-settings', label: messages.sonarr },
          { id: 'override-rules', label: messages.overrideRules },
          { id: 'intervention-cleanup', label: messages.cleanup },
        ].map(({ id, label }) => (
          <a
            key={id}
            href={`#${id}`}
            className="inline-flex min-h-[44px] items-center rounded-lg border border-gray-700 bg-gray-800/50 px-3 py-2 text-sm text-gray-300 transition hover:border-gray-500 hover:text-white focus-visible:ring-2 focus-visible:ring-indigo-400"
          >
            {intl.formatMessage(label)}
          </a>
        ))}
      </nav>

      <div className="flex flex-col gap-3 rounded-xl border border-gray-700 bg-gray-800/40 p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-gray-400">
          {intl.formatMessage(messages.accountHint)}
        </p>
        <LinkButton
          to="/profile/settings/linked-accounts"
          buttonSize="sm"
          className="min-h-[44px]"
        >
          {intl.formatMessage(messages.linkedAccounts)}
        </LinkButton>
      </div>

      <div id="discovery-integrations" className="mb-6 mt-10 scroll-mt-24">
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
