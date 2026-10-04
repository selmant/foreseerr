import AnilistLogo from '@app/assets/services/anilist.svg';
import EmbyLogo from '@app/assets/services/emby-icon-only.svg';
import JellyfinLogo from '@app/assets/services/jellyfin-icon.svg';
import PlexLogo from '@app/assets/services/plex.svg';
import SimklLogo from '@app/assets/services/simkl.svg';
import TraktLogo from '@app/assets/services/trakt.svg';
import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import LinkButton from '@app/components/Common/LinkButton';
import PageTitle from '@app/components/Common/PageTitle';
import SettingsBadge from '@app/components/Settings/SettingsBadge';
import LinkAnilistModal from '@app/components/UserProfile/UserSettings/UserLinkedAccountsSettings/LinkAnilistModal';
import LinkJellyfinQuickConnectModal from '@app/components/UserProfile/UserSettings/UserLinkedAccountsSettings/LinkJellyfinQuickConnectModal';
import LinkSimklModal from '@app/components/UserProfile/UserSettings/UserLinkedAccountsSettings/LinkSimklModal';
import LinkTraktModal from '@app/components/UserProfile/UserSettings/UserLinkedAccountsSettings/LinkTraktModal';
import useHashNavigation from '@app/hooks/useHashNavigation';
import useRouteQuery from '@app/hooks/useRouteQuery';
import useSettings from '@app/hooks/useSettings';
import { Permission, UserType, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import PlexOAuth from '@app/utils/plex';
import {
  CheckIcon,
  LinkIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/solid';
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
      'Manage connections for library playback, personal lists, and watch/rating sync.',
    availableConnections: 'Available connections',
    linkService: 'Link {service}',
    jellyfinDescription: 'Browse your library and play movies and episodes.',
    mediaServerDescription:
      'Sign in and see media availability from {service}.',
    traktDescription:
      'Use your recommendations, watchlist, history, and ratings.',
    anilistDescription: 'Use your anime lists, watched status, and scores.',
    simklDescription: 'Use the movies, series, and anime you track.',
    browseSources: 'Browse sources',
    openLibrary: 'Open library',
    openWatchlist: 'Open watchlist',
    openAnimeList: 'Open anime list',
    linked: 'Linked',
    needsAttention: 'Needs attention',
    unlink: 'Unlink',
    unlinkConfirm: 'Unlink?',
    trackerLabel: '{service} watch sync',
    trackerOn: 'Sync on',
    trackerOff: 'Sync off',
    savingTracker: 'Saving sync preference…',
    loadingServices: 'Loading linked services…',
    servicesError: 'Some linked services could not be checked.',
    retry: 'Refresh connections',
    anilistExpired:
      'Your AniList sign-in has expired. Link AniList again to restore access.',
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
      'Your Jellyfin session needs to be refreshed before Better Trakt can be used. Choose “Refresh session” on your Jellyfin connection and sign in again.',
    betterTraktNeedsRefresh: 'Refresh your Jellyfin session',
    betterTraktNeedsLink: 'Link Trakt in Better Trakt',
    betterTraktNeedsAccess: 'Allow Foreseerr access in Jellyfin',
    betterTraktNeedsJellyfin: 'Link your Jellyfin account first',
    betterTraktUnavailable: 'Better Trakt unavailable',
    refreshJellyfinSession: 'Refresh Jellyfin Session',
    refreshSession: 'Refresh session',
    watchTrackers: 'Watch Trackers',
    watchTrackersHint:
      'Choose which linked services receive watched status and ratings from {applicationName}.',
    traktWatchHint:
      'Updates your Trakt history and ratings when you mark titles watched here.',
    anilistWatchHint:
      'Updates your AniList list and scores when you mark anime watched here.',
    anilistExperimentalTooltip:
      'Anime seasons and episodes do not always match TMDB one-to-one, so watches can land on the wrong AniList title or be skipped.',
    simklWatchHint:
      'Updates your Simkl history and ratings when you mark titles watched here.',
    linkAccountToEnable: 'Link this account to enable watch sync.',
    disabledServerWide:
      'Watch sync for this service is turned off for everyone by an administrator.',
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
  label,
  enabled,
  disabled,
  busy,
  onToggle,
}: {
  label: string;
  enabled: boolean;
  disabled: boolean;
  busy: boolean;
  onToggle: () => void;
}) => (
  <button
    type="button"
    role="switch"
    aria-label={label}
    aria-checked={enabled}
    aria-busy={busy}
    disabled={disabled}
    onClick={() => {
      if (!disabled) {
        onToggle();
      }
    }}
    className={`relative inline-flex h-11 w-11 flex-shrink-0 items-center rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
      disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
    }`}
  >
    <span
      aria-hidden="true"
      className={`inline-flex h-6 w-11 rounded-full border-2 border-transparent transition-colors duration-200 ${enabled ? 'bg-indigo-600' : 'bg-gray-700'}`}
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
  const {
    data: anilistStatus,
    error: anilistError,
    mutate: revalidateAnilist,
  } = useSWR<{
    connected: boolean;
    expired?: boolean;
    username: string | null;
    actionsEnabled?: boolean;
  }>(
    user && settings.currentSettings.anilistConfigured
      ? `/api/v1/user/${user.id}/settings/linked-accounts/anilist`
      : null
  );
  const {
    data: traktStatus,
    error: traktError,
    mutate: revalidateTrakt,
  } = useSWR<{
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
  const {
    data: simklStatus,
    error: simklError,
    mutate: revalidateSimkl,
  } = useSWR<{
    connected: boolean;
    username: string | null;
    actionsEnabled?: boolean;
  }>(
    user && settings.currentSettings.simklConfigured
      ? `/api/v1/user/${user.id}/settings/linked-accounts/simkl`
      : null
  );
  const [showJellyfinModal, setShowJellyfinModal] = useState(false);
  useHashNavigation(
    Boolean(
      user &&
      (!settings.currentSettings.anilistConfigured ||
        anilistStatus ||
        anilistError) &&
      (!settings.currentSettings.traktConfigured ||
        traktStatus ||
        traktError) &&
      (!settings.currentSettings.simklConfigured || simklStatus || simklError)
    )
  );
  const [showJellyfinQuickConnectModal, setShowJellyfinQuickConnectModal] =
    useState(false);
  const [showTraktModal, setShowTraktModal] = useState(false);
  const [showAnilistModal, setShowAnilistModal] = useState(false);
  const [showSimklModal, setShowSimklModal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingTrackers, setSavingTrackers] = useState<Set<string>>(new Set());
  const [trackerErrors, setTrackerErrors] = useState<
    Partial<Record<string, string>>
  >({});

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
      type: LinkedAccountType.Jellyfin,
      refresh: true,
      name: intl.formatMessage(messages.refreshJellyfinSession),
      action: () => setShowJellyfinModal(true),
      hide:
        traktStatus?.provider !== 'jellyfin' ||
        settings.currentSettings.mediaServerType !== MediaServerType.JELLYFIN ||
        !accounts.some((a) => a.type === LinkedAccountType.Jellyfin),
    },
    {
      type: LinkedAccountType.Plex,
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
      type: LinkedAccountType.Jellyfin,
      name: 'Jellyfin',
      action: () => setShowJellyfinModal(true),
      hide:
        settings.currentSettings.mediaServerType !== MediaServerType.JELLYFIN ||
        accounts.some((a) => a.type === LinkedAccountType.Jellyfin),
    },
    {
      type: LinkedAccountType.Emby,
      name: 'Emby',
      action: () => setShowJellyfinModal(true),
      hide:
        settings.currentSettings.mediaServerType !== MediaServerType.EMBY ||
        accounts.some((a) => a.type === LinkedAccountType.Emby),
    },
    {
      type: LinkedAccountType.Trakt,
      name: 'Trakt',
      action: () => setShowTraktModal(true),
      hide:
        !settings.currentSettings.traktConfigured ||
        !traktStatus ||
        traktStatus?.provider === 'jellyfin' ||
        accounts.some((a) => a.type === LinkedAccountType.Trakt),
    },
    {
      type: LinkedAccountType.Anilist,
      name: 'AniList',
      action: () => setShowAnilistModal(true),
      hide:
        !settings.currentSettings.anilistConfigured ||
        !anilistStatus ||
        accounts.some((a) => a.type === LinkedAccountType.Anilist),
    },
    {
      type: LinkedAccountType.Simkl,
      name: 'Simkl',
      action: () => setShowSimklModal(true),
      hide:
        !settings.currentSettings.simklConfigured ||
        !simklStatus ||
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
    setSavingTrackers((current) => new Set(current).add(account));
    setTrackerErrors((current) => ({ ...current, [account]: undefined }));
    try {
      await axios.patch(
        `/api/v1/user/${user.id}/settings/linked-accounts/${account}`,
        { actionsEnabled }
      );
      if (account === 'trakt') await revalidateTrakt();
      else if (account === 'anilist') await revalidateAnilist();
      else await revalidateSimkl();
    } catch {
      setTrackerErrors((current) => ({
        ...current,
        [account]: intl.formatMessage(messages.updateFailed),
      }));
    } finally {
      setSavingTrackers((current) => {
        const next = new Set(current);
        next.delete(account);
        return next;
      });
    }
  };

  if (
    currentUser?.id !== user?.id &&
    hasPermission(Permission.ADMIN) &&
    currentUser?.id !== 1
  ) {
    return (
      <>
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

  const connectionDescription = (type: LinkedAccountType) =>
    intl.formatMessage(
      type === LinkedAccountType.Jellyfin
        ? messages.jellyfinDescription
        : type === LinkedAccountType.Trakt
          ? messages.traktDescription
          : type === LinkedAccountType.Anilist
            ? messages.anilistDescription
            : type === LinkedAccountType.Simkl
              ? messages.simklDescription
              : messages.mediaServerDescription,
      { service: type }
    );
  const accountDestination = (type: LinkedAccountType) => {
    switch (type) {
      case LinkedAccountType.Jellyfin:
        return { href: '/library', label: messages.openLibrary };
      case LinkedAccountType.Trakt:
        return {
          href: '/discover/trakt/watchlist',
          label: messages.openWatchlist,
        };
      case LinkedAccountType.Anilist:
        return {
          href: '/discover/anilist/watching',
          label: messages.openAnimeList,
        };
      case LinkedAccountType.Simkl:
        return {
          href: '/discover/simkl?status=plantowatch',
          label: messages.openWatchlist,
        };
      default:
        return undefined;
    }
  };

  const trackers = [
    {
      id: 'trakt' as const,
      name: 'Trakt',
      Logo: TraktLogo,
      configured: settings.currentSettings.traktConfigured,
      serverEnabled: settings.currentSettings.mediaActionsTraktEnabled,
      status: traktStatus,
      hint: messages.traktWatchHint,
      experimental: false,
    },
    {
      id: 'anilist' as const,
      name: 'AniList',
      Logo: AnilistLogo,
      configured: settings.currentSettings.anilistConfigured,
      serverEnabled: settings.currentSettings.mediaActionsAnilistEnabled,
      status: anilistStatus,
      hint: messages.anilistWatchHint,
      experimental: true,
    },
    {
      id: 'simkl' as const,
      name: 'Simkl',
      Logo: SimklLogo,
      configured: settings.currentSettings.simklConfigured,
      serverEnabled: settings.currentSettings.mediaActionsSimklEnabled,
      status: simklStatus,
      hint: messages.simklWatchHint,
      experimental: false,
    },
  ].filter((tracker) => tracker.configured);
  const servicesLoading = Boolean(
    (settings.currentSettings.traktConfigured && !traktStatus && !traktError) ||
    (settings.currentSettings.anilistConfigured &&
      !anilistStatus &&
      !anilistError) ||
    (settings.currentSettings.simklConfigured && !simklStatus && !simklError)
  );

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.linkedAccounts),
          intl.formatMessage(globalMessages.usersettings),
          user?.displayName,
        ]}
      />
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="heading">
            {intl.formatMessage(messages.linkedAccounts)}
          </h3>
          <h6 className="description">
            {intl.formatMessage(messages.linkedAccountsHint)}
          </h6>
        </div>
        {currentUser?.id === user?.id && (
          <div className="flex flex-wrap gap-2">
            {trackers.length ? (
              <LinkButton to="#watch-trackers" className="min-h-11">
                {intl.formatMessage(messages.watchTrackers)}
              </LinkButton>
            ) : null}
            <LinkButton to="/discover/sources" className="min-h-11">
              {intl.formatMessage(messages.browseSources)}
            </LinkButton>
          </div>
        )}
      </div>
      {servicesLoading ? (
        <p role="status" className="mb-4 text-sm text-gray-400">
          {intl.formatMessage(messages.loadingServices)}
        </p>
      ) : null}
      {traktError || anilistError || simklError ? (
        <Alert
          type="warning"
          title={intl.formatMessage(messages.servicesError)}
        >
          <Button
            className="mt-2 min-h-11"
            onClick={() =>
              void Promise.all([
                revalidateTrakt(),
                revalidateAnilist(),
                revalidateSimkl(),
              ])
            }
          >
            {intl.formatMessage(messages.retry)}
          </Button>
        </Alert>
      ) : null}
      {anilistStatus?.expired ? (
        <Alert
          type="warning"
          title={intl.formatMessage(messages.anilistExpired)}
        />
      ) : null}
      {currentUser?.id === user?.id &&
      linkable.some((connection) => !connection.refresh) ? (
        <section className="mb-6">
          <h3 className="mb-3 text-lg font-semibold">
            {intl.formatMessage(messages.availableConnections)}
          </h3>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {linkable
              .filter((connection) => !connection.refresh)
              .map(({ type, name, action }) => (
                <div
                  key={type}
                  className="flex flex-col rounded-xl border border-gray-700 bg-gray-800/40 p-4"
                >
                  <div className="mb-3 flex items-center gap-3">
                    <div className="h-10 w-10 shrink-0">
                      {renderAccountLogo(type)}
                    </div>
                    <h4 className="font-semibold">{name}</h4>
                  </div>
                  <p className="mb-4 flex-1 text-sm text-gray-400">
                    {connectionDescription(type)}
                  </p>
                  <Button className="min-h-11 self-start" onClick={action}>
                    <LinkIcon />
                    <span>
                      {intl.formatMessage(messages.linkService, {
                        service: name,
                      })}
                    </span>
                  </Button>
                </div>
              ))}
          </div>
        </section>
      ) : null}
      {error && <Alert title={error} type="error" />}
      {currentUser?.id === user?.id &&
        traktStatus?.provider === 'jellyfin' &&
        traktStatus.pluginState !== 'ready' && (
          <Alert
            title={intl.formatMessage(
              traktStatus.needsJellyfinSessionRefresh
                ? messages.betterTraktSessionRefresh
                : messages.betterTraktEnabled
            )}
            type={traktStatus.needsJellyfinSessionRefresh ? 'warning' : 'info'}
          />
        )}
      {accounts.length ? (
        <ul className="space-y-4">
          {accounts.map((acct) => {
            const destination = accountDestination(acct.type);
            return (
              <li
                key={acct.type}
                className="flex flex-wrap items-center gap-4 rounded-lg bg-gray-800/50 px-4 py-5 shadow ring-1 ring-gray-700 sm:p-6"
              >
                <div className="h-12 w-12 shrink-0">
                  {renderAccountLogo(acct.type)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="truncate text-sm font-bold text-gray-300">
                      {acct.type}
                    </div>
                    <Badge
                      badgeType={
                        acct.viaPlugin && !pluginAccountReady(acct)
                          ? 'warning'
                          : 'success'
                      }
                    >
                      {intl.formatMessage(
                        acct.viaPlugin && !pluginAccountReady(acct)
                          ? messages.needsAttention
                          : messages.linked
                      )}
                    </Badge>
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
                    <div className="break-words text-xl font-semibold text-white">
                      {acct.viaPlugin
                        ? pluginAccountLabel(acct)
                        : acct.username}
                    </div>
                  )}
                  <p className="mt-1 text-sm text-gray-400">
                    {connectionDescription(acct.type)}
                  </p>
                </div>
                <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                  {currentUser?.id === user?.id &&
                  destination &&
                  (!acct.viaPlugin || pluginAccountReady(acct)) ? (
                    <LinkButton to={destination.href} className="min-h-11">
                      {intl.formatMessage(destination.label)}
                    </LinkButton>
                  ) : null}
                  {currentUser?.id === user?.id &&
                  acct.type === LinkedAccountType.Jellyfin &&
                  linkable.find((connection) => connection.refresh) ? (
                    <Button
                      className="min-h-11"
                      aria-label={intl.formatMessage(
                        messages.refreshJellyfinSession
                      )}
                      onClick={() => setShowJellyfinModal(true)}
                    >
                      {intl.formatMessage(messages.refreshSession)}
                    </Button>
                  ) : null}
                  {!acct.viaPlugin &&
                    (acct.type === LinkedAccountType.Trakt ||
                    acct.type === LinkedAccountType.Anilist ||
                    acct.type === LinkedAccountType.Simkl
                      ? currentUser?.id === user?.id ||
                        hasPermission(Permission.MANAGE_USERS)
                      : enableMediaServerUnlink) && (
                      <ConfirmButton
                        className="min-h-11"
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
                        confirmText={intl.formatMessage(messages.unlinkConfirm)}
                      >
                        <TrashIcon />
                        <span>{intl.formatMessage(messages.unlink)}</span>
                      </ConfirmButton>
                    )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : !servicesLoading ? (
        <div className="mt-4 text-center md:py-12">
          <h3 className="text-lg font-semibold text-gray-400">
            {intl.formatMessage(messages.noLinkedAccounts)}
          </h3>
        </div>
      ) : null}

      {(settings.currentSettings.traktConfigured ||
        settings.currentSettings.anilistConfigured ||
        settings.currentSettings.simklConfigured) && (
        <div id="watch-trackers" className="mt-10 scroll-mt-24">
          <h3 className="heading">
            {intl.formatMessage(messages.watchTrackers)}
          </h3>
          <h6 className="description">
            {intl.formatMessage(messages.watchTrackersHint, {
              applicationName,
            })}
          </h6>
          <ul className="mt-4 space-y-3">
            {trackers.map(
              ({
                id,
                name,
                Logo,
                serverEnabled,
                status,
                hint,
                experimental,
              }) => {
                const enabled = Boolean(
                  serverEnabled &&
                  status?.connected &&
                  status.actionsEnabled !== false
                );
                const busy = savingTrackers.has(id);
                return (
                  <li
                    key={id}
                    className="flex items-center gap-4 rounded-lg bg-gray-800/50 px-4 py-4 shadow ring-1 ring-gray-700 sm:px-6"
                  >
                    <Logo className="h-7 w-7 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h4 className="text-sm font-bold text-gray-200">
                          {name}
                        </h4>
                        {experimental ? (
                          <SettingsBadge
                            badgeType="experimental"
                            tooltip={intl.formatMessage(
                              messages.anilistExperimentalTooltip
                            )}
                          />
                        ) : null}
                        {status?.connected && serverEnabled ? (
                          <span
                            className={`text-xs ${enabled ? 'text-indigo-300' : 'text-gray-400'}`}
                          >
                            {intl.formatMessage(
                              enabled ? messages.trackerOn : messages.trackerOff
                            )}
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-1 text-sm text-gray-400">
                        {intl.formatMessage(
                          !serverEnabled
                            ? messages.disabledServerWide
                            : !status?.connected
                              ? messages.linkAccountToEnable
                              : hint
                        )}
                      </p>
                      {busy ? (
                        <p
                          className="mt-1 text-sm text-indigo-300"
                          role="status"
                        >
                          {intl.formatMessage(messages.savingTracker)}
                        </p>
                      ) : null}
                      {trackerErrors[id] ? (
                        <p className="mt-1 text-sm text-red-300" role="alert">
                          {trackerErrors[id]}
                        </p>
                      ) : null}
                    </div>
                    <WatchTrackerSwitch
                      label={intl.formatMessage(messages.trackerLabel, {
                        service: name,
                      })}
                      enabled={enabled}
                      busy={busy}
                      disabled={busy || !serverEnabled || !status?.connected}
                      onToggle={() =>
                        void updateActionsEnabled(
                          id,
                          status?.actionsEnabled === false
                        )
                      }
                    />
                  </li>
                );
              }
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
