import AnilistLogo from '@app/assets/services/anilist.svg';
import EmbyLogo from '@app/assets/services/emby-icon-only.svg';
import JellyfinLogo from '@app/assets/services/jellyfin-icon.svg';
import PlexLogo from '@app/assets/services/plex.svg';
import SimklLogo from '@app/assets/services/simkl.svg';
import TraktLogo from '@app/assets/services/trakt.svg';
import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import Dropdown from '@app/components/Common/Dropdown';
import PageTitle from '@app/components/Common/PageTitle';
import SettingsBadge from '@app/components/Settings/SettingsBadge';
import LinkAnilistModal from '@app/components/UserProfile/UserSettings/UserLinkedAccountsSettings/LinkAnilistModal';
import LinkJellyfinQuickConnectModal from '@app/components/UserProfile/UserSettings/UserLinkedAccountsSettings/LinkJellyfinQuickConnectModal';
import LinkSimklModal from '@app/components/UserProfile/UserSettings/UserLinkedAccountsSettings/LinkSimklModal';
import LinkTraktModal from '@app/components/UserProfile/UserSettings/UserLinkedAccountsSettings/LinkTraktModal';
import useRouteQuery from '@app/hooks/useRouteQuery';
import useSettings from '@app/hooks/useSettings';
import { Permission, UserType, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import PlexOAuth from '@app/utils/plex';
import { CheckIcon, TrashIcon, XMarkIcon } from '@heroicons/react/24/solid';
import { MediaServerType } from '@server/constants/server';
import axios from 'axios';
import { useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import LinkJellyfinModal from './LinkJellyfinModal';

const messages = defineMessages(
  'components.UserProfile.UserSettings.UserLinkedAccountsSettings',
  {
    linkedAccounts: 'Linked Accounts',
    linkedAccountsHint:
      'These external accounts are linked to your {applicationName} account.',
    noLinkedAccounts:
      'You do not have any external accounts linked to your account.',
    noPermissionDescription:
      "You do not have permission to modify this user's linked accounts.",
    plexErrorUnauthorized: 'Unable to connect to Plex using your credentials',
    plexErrorExists: 'This account is already linked to a Plex user',
    errorUnknown: 'An unknown error occurred',
    deleteFailed: 'Unable to delete linked account.',
    betterTrakt: 'Better Trakt',
    betterTraktEnabled:
      'Trakt is provided through Better Trakt in Jellyfin. Link your Jellyfin account here, then link Trakt and enable Foreseerr access in the Jellyfin plugin.',
    betterTraktSessionRefresh:
      'Your Jellyfin session needs to be refreshed before Better Trakt can be used. Choose “Refresh Jellyfin Session” from Link Account and sign in again.',
    betterTraktNeedsRefresh: 'Refresh your Jellyfin session',
    betterTraktNeedsLink: 'Link Trakt in Better Trakt',
    betterTraktNeedsAccess: 'Allow Foreseerr access in Jellyfin',
    betterTraktNeedsJellyfin: 'Link your Jellyfin account first',
    betterTraktUnavailable: 'Better Trakt unavailable',
    refreshJellyfinSession: 'Refresh Jellyfin Session',
    watchTrackers: 'Watch trackers',
    watchTrackersHint:
      'Choose which linked services receive watched status and ratings from {applicationName}.',
    traktWatchHint:
      'Updates your Trakt history and ratings when you mark titles watched here.',
    anilistWatchHint:
      'Updates your AniList list and scores when you mark anime watched here.',
    anilistExperimentalTooltip:
      'Anime seasons and episodes do not always match TMDB one-to-one, so watches can land on the wrong AniList title or be skipped.',
    linkAccountToEnable: 'Link this account to enable watch sync.',
    updateFailed: 'Unable to update watch tracker settings.',
  }
);

const plexOAuth = new PlexOAuth();

enum LinkedAccountType {
  Plex = 'Plex',
  Jellyfin = 'Jellyfin',
  Emby = 'Emby',
  Trakt = 'Trakt',
  Anilist = 'AniList',
  Simkl = 'Simkl',
}

type LinkedAccount = {
  type: LinkedAccountType;
  username: string;
  viaPlugin?: boolean;
  pluginState?:
    | 'ready'
    | 'needs_session_refresh'
    | 'needs_trakt_link'
    | 'needs_access'
    | 'unavailable'
    | 'needs_jellyfin';
};

const WatchTrackerSwitch = ({
  enabled,
  disabled,
  onToggle,
}: {
  enabled: boolean;
  disabled: boolean;
  onToggle: () => void;
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={enabled}
    disabled={disabled}
    onClick={() => {
      if (!disabled) {
        onToggle();
      }
    }}
    className={`${
      enabled ? 'bg-indigo-600' : 'bg-gray-700'
    } relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring ${
      disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
    }`}
  >
    <span
      aria-hidden="true"
      className={`${
        enabled ? 'translate-x-5' : 'translate-x-0'
      } relative inline-block h-5 w-5 rounded-full bg-white shadow transition duration-200 ease-in-out`}
    >
      <span
        className={`${
          enabled
            ? 'opacity-0 duration-100 ease-out'
            : 'opacity-100 duration-200 ease-in'
        } absolute inset-0 flex h-full w-full items-center justify-center transition-opacity`}
      >
        <XMarkIcon className="h-3 w-3 text-gray-400" />
      </span>
      <span
        className={`${
          enabled
            ? 'opacity-100 duration-200 ease-in'
            : 'opacity-0 duration-100 ease-out'
        } absolute inset-0 flex h-full w-full items-center justify-center transition-opacity`}
      >
        <CheckIcon className="h-3 w-3 text-indigo-600" />
      </span>
    </span>
  </button>
);

const UserLinkedAccountsSettings = () => {
  const intl = useIntl();
  const settings = useSettings();
  const query = useRouteQuery();
  const { user: currentUser } = useUser();
  const {
    user,
    hasPermission,
    revalidate: revalidateUser,
  } = useUser({ id: Number(query.userId) });
  const { data: passwordInfo } = useSWR<{ hasPassword: boolean }>(
    user ? `/api/v1/user/${user?.id}/settings/password` : null
  );
  const { data: anilistStatus, mutate: revalidateAnilist } = useSWR<{
    connected: boolean;
    expired?: boolean;
    username: string | null;
    actionsEnabled?: boolean;
  }>(
    user && settings.currentSettings.anilistConfigured
      ? `/api/v1/user/${user.id}/settings/linked-accounts/anilist`
      : null
  );
  const { data: traktStatus, mutate: revalidateTrakt } = useSWR<{
    provider: 'direct' | 'jellyfin';
    connected: boolean;
    needsJellyfinSessionRefresh?: boolean;
    pluginState?:
      | 'ready'
      | 'needs_session_refresh'
      | 'needs_trakt_link'
      | 'needs_access'
      | 'unavailable'
      | 'needs_jellyfin';
    username: string | null;
    actionsEnabled?: boolean;
  }>(
    user && settings.currentSettings.traktConfigured
      ? `/api/v1/user/${user.id}/settings/linked-accounts/trakt?includePluginStatus=true`
      : null
  );
  const { data: simklStatus, mutate: revalidateSimkl } = useSWR<{
    connected: boolean;
    username: string | null;
    actionsEnabled?: boolean;
  }>(
    user && settings.currentSettings.simklConfigured
      ? `/api/v1/user/${user.id}/settings/linked-accounts/simkl`
      : null
  );
  const [showJellyfinModal, setShowJellyfinModal] = useState(false);
  const [showJellyfinQuickConnectModal, setShowJellyfinQuickConnectModal] =
    useState(false);
  const [showTraktModal, setShowTraktModal] = useState(false);
  const [showAnilistModal, setShowAnilistModal] = useState(false);
  const [showSimklModal, setShowSimklModal] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applicationName = settings.currentSettings.applicationTitle;

  const accounts: LinkedAccount[] = useMemo(() => {
    const accounts: LinkedAccount[] = [];
    if (!user) return accounts;
    if (user.userType === UserType.PLEX && user.plexUsername)
      accounts.push({
        type: LinkedAccountType.Plex,
        username: user.plexUsername,
      });
    if (user.userType === UserType.EMBY && user.jellyfinUsername)
      accounts.push({
        type: LinkedAccountType.Emby,
        username: user.jellyfinUsername,
      });
    if (user.userType === UserType.JELLYFIN && user.jellyfinUsername)
      accounts.push({
        type: LinkedAccountType.Jellyfin,
        username: user.jellyfinUsername,
      });
    if (traktStatus?.provider === 'jellyfin') {
      accounts.push({
        type: LinkedAccountType.Trakt,
        username: traktStatus.username ?? '',
        viaPlugin: true,
        pluginState: traktStatus.pluginState,
      });
    } else if (traktStatus?.connected && traktStatus.username) {
      accounts.push({
        type: LinkedAccountType.Trakt,
        username: traktStatus.username,
      });
    }
    if (anilistStatus?.connected && anilistStatus.username)
      accounts.push({
        type: LinkedAccountType.Anilist,
        username: anilistStatus.username,
      });
    if (simklStatus?.connected && simklStatus.username)
      accounts.push({
        type: LinkedAccountType.Simkl,
        username: simklStatus.username,
      });
    return accounts;
  }, [user, traktStatus, anilistStatus, simklStatus]);

  const linkPlexAccount = async () => {
    setError(null);
    try {
      const authToken = await plexOAuth.login(
        settings.currentSettings.plexClientIdentifier
      );
      await axios.post(
        `/api/v1/user/${user?.id}/settings/linked-accounts/plex`,
        {
          authToken,
        }
      );
      await revalidateUser();
    } catch (e) {
      switch (e?.response?.status) {
        case 401:
          setError(intl.formatMessage(messages.plexErrorUnauthorized));
          break;
        case 422:
          setError(intl.formatMessage(messages.plexErrorExists));
          break;
        default:
          setError(intl.formatMessage(messages.errorUnknown));
      }
    }
  };

  const linkable = [
    {
      name: intl.formatMessage(messages.refreshJellyfinSession),
      action: () => setShowJellyfinModal(true),
      hide:
        traktStatus?.provider !== 'jellyfin' ||
        settings.currentSettings.mediaServerType !== MediaServerType.JELLYFIN ||
        !accounts.some((a) => a.type === LinkedAccountType.Jellyfin),
    },
    {
      name: 'Plex',
      action: () => {
        plexOAuth.preparePopup();
        setTimeout(() => linkPlexAccount(), 1500);
      },
      hide:
        settings.currentSettings.mediaServerType !== MediaServerType.PLEX ||
        accounts.some((a) => a.type === LinkedAccountType.Plex),
    },
    {
      name: 'Jellyfin',
      action: () => setShowJellyfinModal(true),
      hide:
        settings.currentSettings.mediaServerType !== MediaServerType.JELLYFIN ||
        accounts.some((a) => a.type === LinkedAccountType.Jellyfin),
    },
    {
      name: 'Emby',
      action: () => setShowJellyfinModal(true),
      hide:
        settings.currentSettings.mediaServerType !== MediaServerType.EMBY ||
        accounts.some((a) => a.type === LinkedAccountType.Emby),
    },
    {
      name: 'Trakt',
      action: () => setShowTraktModal(true),
      hide:
        !settings.currentSettings.traktConfigured ||
        traktStatus?.provider === 'jellyfin' ||
        accounts.some((a) => a.type === LinkedAccountType.Trakt),
    },
    {
      name: 'AniList',
      action: () => setShowAnilistModal(true),
      hide:
        !settings.currentSettings.anilistConfigured ||
        accounts.some((a) => a.type === LinkedAccountType.Anilist),
    },
    {
      name: 'Simkl',
      action: () => setShowSimklModal(true),
      hide:
        !settings.currentSettings.simklConfigured ||
        accounts.some((a) => a.type === LinkedAccountType.Simkl),
    },
  ].filter((l) => !l.hide);

  const deleteRequest = async (account: string) => {
    try {
      await axios.delete(
        `/api/v1/user/${user?.id}/settings/linked-accounts/${account}`
      );
    } catch {
      setError(intl.formatMessage(messages.deleteFailed));
    }

    await revalidateUser();
    if (account === 'trakt') {
      await revalidateTrakt();
    }
    if (account === 'anilist') {
      await revalidateAnilist();
    }
    if (account === 'simkl') await revalidateSimkl();
  };

  const updateActionsEnabled = async (
    account: 'trakt' | 'anilist' | 'simkl',
    actionsEnabled: boolean
  ) => {
    if (!user) {
      return;
    }
    setError(null);
    try {
      await axios.patch(
        `/api/v1/user/${user.id}/settings/linked-accounts/${account}`,
        { actionsEnabled }
      );
    } catch {
      setError(intl.formatMessage(messages.updateFailed));
    }

    if (account === 'trakt') {
      await revalidateTrakt();
    } else if (account === 'anilist') {
      await revalidateAnilist();
    } else {
      await revalidateSimkl();
    }
  };

  if (
    currentUser?.id !== user?.id &&
    hasPermission(Permission.ADMIN) &&
    currentUser?.id !== 1
  ) {
    return (
      <>
        {traktStatus?.provider === 'jellyfin' && (
          <Alert
            title={intl.formatMessage(
              traktStatus.needsJellyfinSessionRefresh
                ? messages.betterTraktSessionRefresh
                : messages.betterTraktEnabled
            )}
            type={traktStatus.needsJellyfinSessionRefresh ? 'warning' : 'info'}
          />
        )}
        <div className="mb-6">
          <h3 className="heading">
            {intl.formatMessage(messages.linkedAccounts)}
          </h3>
        </div>
        <Alert
          title={intl.formatMessage(messages.noPermissionDescription)}
          type="error"
        />
      </>
    );
  }

  const enableMediaServerUnlink = user?.id !== 1 && passwordInfo?.hasPassword;

  const renderAccountLogo = (type: LinkedAccountType) => {
    if (type === LinkedAccountType.Plex) {
      return (
        <div className="flex aspect-square h-full items-center justify-center rounded-full bg-neutral-800">
          <PlexLogo className="w-9" />
        </div>
      );
    }
    if (type === LinkedAccountType.Emby) {
      return <EmbyLogo />;
    }
    if (type === LinkedAccountType.Trakt) {
      return (
        <div className="flex aspect-square h-full items-center justify-center rounded-full bg-neutral-800 p-2">
          <TraktLogo className="w-9" />
        </div>
      );
    }
    if (type === LinkedAccountType.Anilist) {
      return (
        <div className="flex aspect-square h-full items-center justify-center rounded-full bg-neutral-800 p-2">
          <AnilistLogo className="w-9" />
        </div>
      );
    }
    if (type === LinkedAccountType.Simkl) {
      return (
        <div className="flex aspect-square h-full items-center justify-center rounded-full bg-neutral-800 p-2">
          <SimklLogo className="w-9" />
        </div>
      );
    }
    return <JellyfinLogo />;
  };

  const pluginAccountReady = (acct: LinkedAccount) =>
    acct.pluginState === 'ready' ||
    (!acct.pluginState && Boolean(acct.username));

  const pluginAccountLabel = (acct: LinkedAccount) => {
    switch (acct.pluginState) {
      case 'needs_session_refresh':
        return intl.formatMessage(messages.betterTraktNeedsRefresh);
      case 'needs_trakt_link':
        return intl.formatMessage(messages.betterTraktNeedsLink);
      case 'needs_access':
        return intl.formatMessage(messages.betterTraktNeedsAccess);
      case 'needs_jellyfin':
        return intl.formatMessage(messages.betterTraktNeedsJellyfin);
      case 'unavailable':
        return intl.formatMessage(messages.betterTraktUnavailable);
      default:
        return (
          acct.username || intl.formatMessage(messages.betterTraktNeedsLink)
        );
    }
  };

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.linkedAccounts),
          intl.formatMessage(globalMessages.usersettings),
          user?.displayName,
        ]}
      />
      <div className="mb-6 flex items-end justify-between">
        <div>
          <h3 className="heading">
            {intl.formatMessage(messages.linkedAccounts)}
          </h3>
          <h6 className="description">
            {intl.formatMessage(messages.linkedAccountsHint, {
              applicationName,
            })}
          </h6>
        </div>
        {currentUser?.id === user?.id && !!linkable.length && (
          <div>
            <Dropdown text="Link Account" buttonType="ghost">
              {linkable.map(({ name, action }) => (
                <Dropdown.Item key={name} onClick={action}>
                  {name}
                </Dropdown.Item>
              ))}
            </Dropdown>
          </div>
        )}
      </div>
      {error && <Alert title={error} type="error" />}
      {accounts.length ? (
        <ul className="space-y-4">
          {accounts.map((acct, i) => (
            <li
              key={i}
              className="flex items-center gap-4 overflow-hidden rounded-lg bg-gray-800/50 px-4 py-5 shadow ring-1 ring-gray-700 sm:p-6"
            >
              <div className="w-12">{renderAccountLogo(acct.type)}</div>
              <div>
                <div className="flex items-center gap-2">
                  <div className="truncate text-sm font-bold text-gray-300">
                    {acct.type}
                  </div>
                  {acct.viaPlugin && (
                    <Badge badgeType="light">
                      {intl.formatMessage(messages.betterTrakt)}
                    </Badge>
                  )}
                </div>
                {acct.viaPlugin && !pluginAccountReady(acct) ? (
                  <div className="text-sm text-gray-400">
                    {pluginAccountLabel(acct)}
                  </div>
                ) : (
                  <div className="text-xl font-semibold text-white">
                    {acct.viaPlugin ? pluginAccountLabel(acct) : acct.username}
                  </div>
                )}
              </div>
              <div className="flex-grow" />
              {!acct.viaPlugin &&
                (acct.type === LinkedAccountType.Trakt ||
                acct.type === LinkedAccountType.Anilist ||
                acct.type === LinkedAccountType.Simkl
                  ? currentUser?.id === user?.id ||
                    hasPermission(Permission.MANAGE_USERS)
                  : enableMediaServerUnlink) && (
                  <ConfirmButton
                    onClick={() => {
                      deleteRequest(
                        acct.type === LinkedAccountType.Plex
                          ? 'plex'
                          : acct.type === LinkedAccountType.Trakt
                            ? 'trakt'
                            : acct.type === LinkedAccountType.Anilist
                              ? 'anilist'
                              : acct.type === LinkedAccountType.Simkl
                                ? 'simkl'
                                : 'jellyfin'
                      );
                    }}
                    confirmText={intl.formatMessage(globalMessages.areyousure)}
                  >
                    <TrashIcon />
                    <span>{intl.formatMessage(globalMessages.delete)}</span>
                  </ConfirmButton>
                )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-4 text-center md:py-12">
          <h3 className="text-lg font-semibold text-gray-400">
            {intl.formatMessage(messages.noLinkedAccounts)}
          </h3>
        </div>
      )}

      {(settings.currentSettings.traktConfigured ||
        settings.currentSettings.anilistConfigured ||
        settings.currentSettings.simklConfigured) && (
        <div className="mt-10">
          <h3 className="heading">
            {intl.formatMessage(messages.watchTrackers)}
          </h3>
          <h6 className="description">
            {intl.formatMessage(messages.watchTrackersHint, {
              applicationName,
            })}
          </h6>
          <ul className="mt-4 space-y-3">
            {settings.currentSettings.traktConfigured && (
              <li className="flex items-center gap-4 overflow-hidden rounded-lg bg-gray-800/50 px-4 py-4 shadow ring-1 ring-gray-700 sm:px-6">
                <TraktLogo className="h-7 w-7" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-bold text-gray-200">
                    Trakt
                  </div>
                  <p className="mt-1 text-sm text-gray-400">
                    {intl.formatMessage(
                      traktStatus?.connected
                        ? messages.traktWatchHint
                        : messages.linkAccountToEnable
                    )}
                  </p>
                </div>
                <WatchTrackerSwitch
                  enabled={traktStatus?.actionsEnabled !== false}
                  disabled={!traktStatus?.connected}
                  onToggle={() => {
                    void updateActionsEnabled(
                      'trakt',
                      traktStatus?.actionsEnabled === false
                    );
                  }}
                />
              </li>
            )}
            {settings.currentSettings.anilistConfigured && (
              <li className="flex items-center gap-4 overflow-hidden rounded-lg bg-gray-800/50 px-4 py-4 shadow ring-1 ring-gray-700 sm:px-6">
                <AnilistLogo className="h-7 w-7" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <div className="truncate text-sm font-bold text-gray-200">
                      AniList
                    </div>
                    <SettingsBadge
                      badgeType="experimental"
                      tooltip={intl.formatMessage(
                        messages.anilistExperimentalTooltip
                      )}
                    />
                  </div>
                  <p className="mt-1 text-sm text-gray-400">
                    {intl.formatMessage(
                      anilistStatus?.connected
                        ? messages.anilistWatchHint
                        : messages.linkAccountToEnable
                    )}
                  </p>
                </div>
                <WatchTrackerSwitch
                  enabled={anilistStatus?.actionsEnabled !== false}
                  disabled={!anilistStatus?.connected}
                  onToggle={() => {
                    void updateActionsEnabled(
                      'anilist',
                      anilistStatus?.actionsEnabled === false
                    );
                  }}
                />
              </li>
            )}
            {settings.currentSettings.simklConfigured && (
              <li className="flex items-center gap-4 overflow-hidden rounded-lg bg-gray-800/50 px-4 py-4 shadow ring-1 ring-gray-700 sm:px-6">
                <SimklLogo className="h-7 w-7" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-bold text-gray-200">
                    Simkl
                  </div>
                  <p className="mt-1 text-sm text-gray-400">
                    {simklStatus?.connected
                      ? 'Updates your Simkl history and ratings when you mark titles watched here.'
                      : intl.formatMessage(messages.linkAccountToEnable)}
                  </p>
                </div>
                <WatchTrackerSwitch
                  enabled={simklStatus?.actionsEnabled !== false}
                  disabled={!simklStatus?.connected}
                  onToggle={() => {
                    void updateActionsEnabled(
                      'simkl',
                      simklStatus?.actionsEnabled === false
                    );
                  }}
                />
              </li>
            )}
          </ul>
        </div>
      )}

      <LinkJellyfinModal
        show={showJellyfinModal}
        onClose={() => setShowJellyfinModal(false)}
        onSave={() => {
          setShowJellyfinModal(false);
          revalidateUser();
          void revalidateTrakt();
        }}
        onSwitchToQuickConnect={() => {
          setShowJellyfinModal(false);
          setShowJellyfinQuickConnectModal(true);
        }}
      />

      <LinkJellyfinQuickConnectModal
        show={showJellyfinQuickConnectModal}
        onClose={() => setShowJellyfinQuickConnectModal(false)}
        onSave={() => {
          setShowJellyfinQuickConnectModal(false);
          revalidateUser();
          void revalidateTrakt();
        }}
        onSwitchToPassword={() => {
          setShowJellyfinQuickConnectModal(false);
          setShowJellyfinModal(true);
        }}
      />

      <LinkTraktModal
        show={showTraktModal}
        onClose={() => setShowTraktModal(false)}
        onSave={() => {
          setShowTraktModal(false);
          void revalidateTrakt();
        }}
      />

      <LinkAnilistModal
        show={showAnilistModal}
        onClose={() => setShowAnilistModal(false)}
        onSave={() => {
          setShowAnilistModal(false);
          void revalidateAnilist();
        }}
      />
      <LinkSimklModal
        show={showSimklModal}
        userId={user?.id}
        onClose={() => setShowSimklModal(false)}
        onSave={() => {
          setShowSimklModal(false);
          void revalidateSimkl();
        }}
      />
    </>
  );
};

export default UserLinkedAccountsSettings;
