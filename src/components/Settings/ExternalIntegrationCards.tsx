import TraktLogo from '@app/assets/services/trakt.svg';
import Badge from '@app/components/Common/Badge';
import Modal from '@app/components/Common/Modal';
import SettingsMdblist from '@app/components/Settings/SettingsMdblist';
import SettingsTrakt from '@app/components/Settings/SettingsTrakt';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { PencilIcon, StarIcon } from '@heroicons/react/24/solid';
import { Fragment, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages(
  'components.Settings.ExternalIntegrationCards',
  {
    trakt: 'Trakt',
    traktDescription:
      'Personalized discovery, watchlists, watched status, and ratings.',
    mdblist: 'MDBList',
    mdblistDescription:
      'IMDb, Rotten Tomatoes, Metacritic, and Trakt community ratings.',
    configured: 'Configured',
    notConfigured: 'Not configured',
    configure: 'Configure',
    edit: 'Edit',
    editTrakt: 'Configure Trakt',
    editMdblist: 'Configure MDBList',
  }
);

type Integration = 'trakt' | 'mdblist';

const ExternalIntegrationCards = () => {
  const intl = useIntl();
  const settings = useSettings();
  const [editing, setEditing] = useState<Integration | null>(null);

  const integrations = [
    {
      id: 'trakt' as const,
      name: intl.formatMessage(messages.trakt),
      description: intl.formatMessage(messages.traktDescription),
      configured: settings.currentSettings.traktConfigured,
      icon: <TraktLogo className="h-10 w-10" />,
    },
    {
      id: 'mdblist' as const,
      name: intl.formatMessage(messages.mdblist),
      description: intl.formatMessage(messages.mdblistDescription),
      configured: settings.currentSettings.mdblistConfigured,
      icon: <StarIcon className="h-10 w-10 text-amber-400" />,
    },
  ];

  return (
    <>
      <ul className="grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-2">
        {integrations.map((integration) => (
          <li
            key={integration.id}
            className="col-span-1 overflow-hidden rounded-lg bg-gray-800 shadow ring-1 ring-gray-500"
          >
            <div className="flex min-h-36 items-start justify-between gap-6 p-6">
              <div className="min-w-0 flex-1">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <h3 className="font-medium leading-5 text-white">
                    {integration.name}
                  </h3>
                  <Badge
                    badgeType={integration.configured ? 'success' : 'warning'}
                  >
                    {intl.formatMessage(
                      integration.configured
                        ? messages.configured
                        : messages.notConfigured
                    )}
                  </Badge>
                </div>
                <p className="text-sm leading-5 text-gray-300">
                  {integration.description}
                </p>
              </div>
              <div className="flex-shrink-0 opacity-90">{integration.icon}</div>
            </div>
            <div className="border-t border-gray-500">
              <button
                type="button"
                onClick={() => setEditing(integration.id)}
                className="relative inline-flex w-full items-center justify-center border border-transparent py-4 text-sm font-medium leading-5 text-gray-200 transition duration-150 ease-in-out hover:text-white focus:z-10 focus:border-gray-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500"
              >
                <PencilIcon className="mr-2 h-5 w-5" />
                <span>
                  {intl.formatMessage(
                    integration.configured ? messages.edit : messages.configure
                  )}
                </span>
              </button>
            </div>
          </li>
        ))}
      </ul>

      <Transition as={Fragment} show={editing === 'trakt'}>
        <Modal
          title={intl.formatMessage(messages.editTrakt)}
          onCancel={() => setEditing(null)}
          backgroundClickable={false}
          dialogClass="sm:max-w-4xl"
        >
          <SettingsTrakt onSave={() => setEditing(null)} />
        </Modal>
      </Transition>

      <Transition as={Fragment} show={editing === 'mdblist'}>
        <Modal
          title={intl.formatMessage(messages.editMdblist)}
          onCancel={() => setEditing(null)}
          backgroundClickable={false}
          dialogClass="sm:max-w-4xl"
        >
          <SettingsMdblist onSave={() => setEditing(null)} />
        </Modal>
      </Transition>
    </>
  );
};

export default ExternalIntegrationCards;
