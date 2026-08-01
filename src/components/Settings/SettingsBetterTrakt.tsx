import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowRightIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Settings.SettingsBetterTrakt', {
  description:
    'Foreseer uses each linked Jellyfin user’s Better Trakt connection. The plugin keeps refresh tokens inside Jellyfin and shares only short-lived access tokens.',
  setup: 'Before switching',
  plugin: 'Install Better Trakt 1000.2026.731.3 or newer in Jellyfin.',
  pluginLink: 'Open Better Trakt releases',
  user: 'Each user links Trakt from the Better Trakt settings in Jellyfin.',
  admin:
    'A Jellyfin administrator enables external token access for each Foreseer user.',
  readiness: 'User readiness',
  readinessSummary:
    '{ready} of {eligible} linked {eligible, plural, one {user is} other {users are}} ready',
  noEligibleUsers:
    'No Foreseer users are linked to Jellyfin yet. Users can finish setup from their Linked Accounts page after this method is active.',
  ready: 'Ready',
  needsSessionRefresh: 'Refresh Jellyfin sign-in',
  needsTraktLink: 'Link Trakt in Better Trakt',
  needsAccess: 'Allow Foreseer access in Jellyfin',
  unavailable: 'Better Trakt unavailable',
  serverWide:
    'This method is configured once for the server, but readiness is checked separately for each Jellyfin user.',
  active: 'Current method',
  switch: 'Switch to Better Trakt',
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

type SettingsBetterTraktProps = {
  active: boolean;
  readiness?: BetterTraktReadiness;
  activating?: boolean;
  onActivate: () => void;
};

const SettingsBetterTrakt = ({
  active,
  readiness,
  activating,
  onActivate,
}: SettingsBetterTraktProps) => {
  const intl = useIntl();

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

  return (
    <div className="space-y-6">
      <p className="description">{intl.formatMessage(messages.description)}</p>

      <Alert type="info" title={intl.formatMessage(messages.serverWide)} />

      <section className="rounded-lg border border-gray-700 bg-gray-900/40 p-5">
        <h4 className="text-base font-semibold text-white">
          {intl.formatMessage(messages.setup)}
        </h4>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-6 text-gray-300">
          <li>
            {intl.formatMessage(messages.plugin)}{' '}
            <a
              href="https://github.com/selmant/better-trakt/releases"
              target="_blank"
              rel="noreferrer"
              className="text-white underline decoration-gray-500 underline-offset-2 hover:decoration-white"
            >
              {intl.formatMessage(messages.pluginLink)}
            </a>
          </li>
          <li>{intl.formatMessage(messages.user)}</li>
          <li>{intl.formatMessage(messages.admin)}</li>
        </ol>
      </section>

      <section aria-labelledby="better-trakt-readiness-heading">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h4
            id="better-trakt-readiness-heading"
            className="text-base font-semibold text-white"
          >
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

        {!readiness || readiness.eligibleUsers === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-600 px-4 py-5 text-sm leading-6 text-gray-400">
            {intl.formatMessage(messages.noEligibleUsers)}
          </div>
        ) : (
          <ul className="divide-y divide-gray-700 overflow-hidden rounded-lg border border-gray-700 bg-gray-900/30">
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
                      <ExclamationTriangleIcon className="h-5 w-5 flex-none text-amber-400" />
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
      </section>

      <div className="flex justify-end border-t border-gray-700 pt-5">
        <Button
          buttonType={active ? 'success' : 'primary'}
          type="button"
          onClick={onActivate}
          disabled={active || activating}
        >
          {!active && <ArrowRightIcon />}
          <span>
            {intl.formatMessage(active ? messages.active : messages.switch)}
          </span>
        </Button>
      </div>
    </div>
  );
};

export default SettingsBetterTrakt;
