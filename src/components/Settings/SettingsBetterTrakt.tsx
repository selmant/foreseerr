import Badge from '@app/components/Common/Badge';
import defineMessages from '@app/utils/defineMessages';
import {
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Settings.SettingsBetterTrakt', {
  setup: 'Better Trakt Setup',
  description:
    'The plugin keeps refresh tokens inside Jellyfin and shares only short-lived access tokens with Foreseerr.',
  plugin: 'Install Better Trakt 1000.2026.731.3 or newer in Jellyfin.',
  pluginLink: 'Open Better Trakt releases',
  user: 'Each user links Trakt from the Better Trakt settings in Jellyfin.',
  admin:
    'A Jellyfin administrator enables external token access for each Foreseerr user.',
  readiness: 'User Readiness',
  readinessDescription:
    'This method is configured once for the server, but readiness is checked separately for each Jellyfin user.',
  readinessSummary:
    '{ready} of {eligible} linked {eligible, plural, one {user is} other {users are}} ready',
  noEligibleUsers:
    'No Foreseerr users are linked to Jellyfin yet. Users can finish setup from their Linked Accounts page after this method is active.',
  ready: 'Ready',
  needsSessionRefresh: 'Refresh Jellyfin sign-in',
  needsTraktLink: 'Link Trakt in Better Trakt',
  needsAccess: 'Allow Foreseerr access in Jellyfin',
  unavailable: 'Better Trakt unavailable',
});

export type BetterTraktUserState =
  | 'ready'
  | 'needs_session_refresh'
  | 'needs_trakt_link'
  | 'needs_access'
  | 'unavailable';

export type BetterTraktReadiness = {
  eligibleUsers: number;
  readyUsers: number;
  users: {
    userId: number;
    displayName: string;
    state: BetterTraktUserState;
  }[];
};

const stateLabel = (state: BetterTraktUserState) => {
  switch (state) {
    case 'ready':
      return messages.ready;
    case 'needs_session_refresh':
      return messages.needsSessionRefresh;
    case 'needs_trakt_link':
      return messages.needsTraktLink;
    case 'needs_access':
      return messages.needsAccess;
    default:
      return messages.unavailable;
  }
};

const SettingsBetterTrakt = ({
  readiness,
}: {
  readiness?: BetterTraktReadiness;
}) => {
  const intl = useIntl();

  return (
    <>
      <h4 className="mt-8 text-lg font-semibold text-gray-100">
        {intl.formatMessage(messages.setup)}
      </h4>
      <p className="description">{intl.formatMessage(messages.description)}</p>
      <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm leading-6 text-gray-300">
        <li>
          {intl.formatMessage(messages.plugin)}{' '}
          <a
            href="https://github.com/selmant/better-trakt/releases"
            target="_blank"
            rel="noreferrer"
            className="text-white underline transition hover:text-gray-200"
          >
            {intl.formatMessage(messages.pluginLink)}
          </a>
        </li>
        <li>{intl.formatMessage(messages.user)}</li>
        <li>{intl.formatMessage(messages.admin)}</li>
      </ol>

      <div className="mt-8 flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-lg font-semibold text-gray-100">
          {intl.formatMessage(messages.readiness)}
        </h4>
        {readiness && readiness.eligibleUsers > 0 && (
          <span className="text-sm text-gray-400">
            {intl.formatMessage(messages.readinessSummary, {
              ready: readiness.readyUsers,
              eligible: readiness.eligibleUsers,
            })}
          </span>
        )}
      </div>
      <p className="description">
        {intl.formatMessage(messages.readinessDescription)}
      </p>
      {!readiness || readiness.eligibleUsers === 0 ? (
        <p className="mt-3 rounded-md border border-dashed border-gray-600 px-4 py-4 text-sm text-gray-400">
          {intl.formatMessage(messages.noEligibleUsers)}
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-gray-700 overflow-hidden rounded-md border border-gray-700 shadow">
          {readiness.users.map((user) => {
            const ready = user.state === 'ready';
            return (
              <li
                key={user.userId}
                className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
              >
                <span className="flex min-w-0 items-center gap-3 text-sm font-medium text-gray-100">
                  {ready ? (
                    <CheckCircleIcon className="h-5 w-5 flex-none text-green-400" />
                  ) : (
                    <ExclamationTriangleIcon className="h-5 w-5 flex-none text-yellow-500" />
                  )}
                  <span className="truncate">{user.displayName}</span>
                </span>
                <Badge badgeType={ready ? 'success' : 'warning'}>
                  {intl.formatMessage(stateLabel(user.state))}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
};

export default SettingsBetterTrakt;
