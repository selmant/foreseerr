import AnilistLogo from '@app/assets/services/anilist.svg';
import MdblistLogo from '@app/assets/services/mdblist.svg';
import TraktLogo from '@app/assets/services/trakt.svg';
import Badge from '@app/components/Common/Badge';
import Modal from '@app/components/Common/Modal';
import SettingsAnilist from '@app/components/Settings/SettingsAnilist';
import SettingsBadge from '@app/components/Settings/SettingsBadge';
import SettingsMdblist from '@app/components/Settings/SettingsMdblist';
import SettingsTrakt from '@app/components/Settings/SettingsTrakt';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { PencilIcon } from '@heroicons/react/24/solid';
import { Fragment, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.Settings.ExternalIntegrationCards',
  {
    trakt: 'Trakt',
    traktDescription:
      'Personalized discovery, watchlists, and ratings. Watched status also comes from Jellyfin.',
    mdblist: 'MDBList',
    mdblistDescription:
      'IMDb, Rotten Tomatoes, Metacritic, and Trakt community ratings, plus public list pinning on Discover.',
    anilist: 'AniList',
    anilistDescription:
      'Anime catalog rows (trending, season, popular, top, next season), personal lists, and watched/score sync.',
    anilistExperimentalTooltip:
      'Anime seasons and episodes do not always match TMDB one-to-one, so watches can land on the wrong AniList title or be skipped.',
    configured: 'Configured',
    notConfigured: 'Not configured',
    connected: 'Reachable',
    degraded: 'Needs attention',
    configure: 'Configure',
    edit: 'Edit',
    editTrakt: 'Configure Trakt',
    editMdblist: 'Configure MDBList',
    editAnilist: 'Configure AniList',
    statusUnavailable: 'Status unavailable',
    checkedAt: 'Checked {time}',
  }
);

type Integration = 'trakt' | 'mdblist' | 'anilist';

type IntegrationHealth = {
  state: 'not_configured' | 'healthy' | 'degraded';
  detail: string;
  checkedAt: string | null;
};

type IntegrationHealthResponse = {
  trakt: IntegrationHealth & { provider: 'direct' | 'jellyfin' };
  mdblist: IntegrationHealth;
  anilist: IntegrationHealth;
};

const ExternalIntegrationCards = () => {
  const intl = useIntl();
  const settings = useSettings();
  const [editing, setEditing] = useState<Integration | null>(null);
  const { data: health, error: healthError } =
    useSWR<IntegrationHealthResponse>('/api/v1/settings/integrations/status', {
      refreshInterval: 5 * 60 * 1000,
    });

  const integrations = [
    {
      id: 'trakt' as const,
      name: intl.formatMessage(messages.trakt),
      description: intl.formatMessage(messages.traktDescription),
      health: health?.trakt,
      configured: settings.currentSettings.traktConfigured,
      icon: <TraktLogo className="h-10 w-10" />,
    },
    {
      id: 'mdblist' as const,
      name: intl.formatMessage(messages.mdblist),
      description: intl.formatMessage(messages.mdblistDescription),
      health: health?.mdblist,
      configured: settings.currentSettings.mdblistConfigured,
      icon: <MdblistLogo className="h-10 w-10" />,
    },
    {
      id: 'anilist' as const,
      name: intl.formatMessage(messages.anilist),
      description: intl.formatMessage(messages.anilistDescription),
      health: health?.anilist,
      configured: settings.currentSettings.anilistConfigured,
      icon: <AnilistLogo className="h-10 w-10" />,
    },
  ];

  return (
    <>
      <ul className="grid max-w-6xl grid-cols-1 gap-6 lg:grid-cols-2">
        {integrations.map((integration) => {
          const healthState = integration.health?.state;
          const badgeType = healthError
            ? ('light' as const)
            : healthState
              ? healthState === 'healthy'
                ? 'success'
                : healthState === 'degraded'
                  ? 'danger'
                  : 'warning'
              : integration.configured
                ? 'success'
                : 'warning';
          const badgeMessage = healthError
            ? messages.statusUnavailable
            : healthState
              ? healthState === 'healthy'
                ? messages.connected
                : healthState === 'degraded'
                  ? messages.degraded
                  : messages.notConfigured
              : integration.configured
                ? messages.configured
                : messages.notConfigured;

          return (
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
                    {integration.id === 'anilist' && (
                      <SettingsBadge
                        badgeType="experimental"
                        tooltip={intl.formatMessage(
                          messages.anilistExperimentalTooltip
                        )}
                      />
                    )}
                    <Badge badgeType={badgeType}>
                      {intl.formatMessage(badgeMessage)}
                    </Badge>
                  </div>
                  <p className="text-sm leading-5 text-gray-300">
                    {integration.description}
                  </p>
                  {integration.health && (
                    <>
                      <p className="mt-2 text-xs leading-5 text-gray-400">
                        {integration.health.detail}
                      </p>
                      {integration.health.checkedAt && (
                        <p className="mt-1 text-xs text-gray-500">
                          {intl.formatMessage(messages.checkedAt, {
                            time: intl.formatDate(
                              integration.health.checkedAt,
                              { hour: 'numeric', minute: '2-digit' }
                            ),
                          })}
                        </p>
                      )}
                    </>
                  )}
                </div>
                <div className="flex-shrink-0 opacity-90">
                  {integration.icon}
                </div>
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
                      integration.configured
                        ? messages.edit
                        : messages.configure
                    )}
                  </span>
                </button>
              </div>
            </li>
          );
        })}
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

      <Transition as={Fragment} show={editing === 'anilist'}>
        <Modal
          title={intl.formatMessage(messages.editAnilist)}
          onCancel={() => setEditing(null)}
          backgroundClickable={false}
          dialogClass="sm:max-w-4xl"
        >
          <SettingsAnilist onSave={() => setEditing(null)} />
        </Modal>
      </Transition>
    </>
  );
};

export default ExternalIntegrationCards;
