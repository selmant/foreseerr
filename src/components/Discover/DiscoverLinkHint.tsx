import LinkButton from '@app/components/Common/LinkButton';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { LinkIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { DiscoverSliderType } from '@server/constants/discover';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.DiscoverLinkHint', {
  hint: 'Link {services} to fill in your personal rows.',
  linkedAccounts: 'Linked Accounts',
  dismiss: 'Dismiss',
});

type LinkedService = 'trakt' | 'anilist' | 'simkl';

const SERVICE_LABELS: Record<LinkedService, string> = {
  trakt: 'Trakt',
  anilist: 'AniList',
  simkl: 'Simkl',
};

/** Rows that stay hidden until the viewer links the matching account. */
const PERSONAL_ROWS: Record<LinkedService, DiscoverSliderType[]> = {
  trakt: [
    DiscoverSliderType.TRAKT_RECOMMENDATIONS,
    DiscoverSliderType.TRAKT_WATCHLIST,
    DiscoverSliderType.TRAKT_HISTORY,
  ],
  anilist: [
    DiscoverSliderType.ANILIST_WATCHING,
    DiscoverSliderType.ANILIST_PLANNING,
    DiscoverSliderType.ANILIST_COMPLETED,
    DiscoverSliderType.ANILIST_LIST,
  ],
  simkl: [
    DiscoverSliderType.SIMKL_PLAN_TO_WATCH,
    DiscoverSliderType.SIMKL_WATCHING,
    DiscoverSliderType.SIMKL_ON_HOLD,
    DiscoverSliderType.SIMKL_COMPLETED,
    DiscoverSliderType.SIMKL_DROPPED,
  ],
};

const dismissKey = (userId: number) => `discover-link-hint-dismissed:${userId}`;

const useLinkStatus = (service: LinkedService, wanted: boolean) => {
  const { user } = useUser();
  // Same keys the personal sliders use, so SWR shares the responses.
  const { data } = useSWR<{ connected: boolean }>(
    wanted && user
      ? `/api/v1/user/${user.id}/settings/linked-accounts/${service}`
      : null
  );
  return data;
};

/**
 * Personal Discover rows hide themselves when the account is not linked, so
 * without this hint a new user never learns those rows exist.
 */
const DiscoverLinkHint = ({
  enabledTypes,
}: {
  enabledTypes: DiscoverSliderType[];
}) => {
  const intl = useIntl();
  const { user } = useUser();
  const { currentSettings } = useSettings();
  const [dismissed, setDismissed] = useState(true);

  const wants = (service: LinkedService, configured: boolean) =>
    configured &&
    PERSONAL_ROWS[service].some((type) => enabledTypes.includes(type));
  const wantTrakt = wants('trakt', currentSettings.traktConfigured);
  const wantAnilist = wants('anilist', currentSettings.anilistConfigured);
  const wantSimkl = wants('simkl', currentSettings.simklConfigured);
  const statuses: [LinkedService, { connected: boolean } | undefined][] = [
    ['trakt', useLinkStatus('trakt', wantTrakt)],
    ['anilist', useLinkStatus('anilist', wantAnilist)],
    ['simkl', useLinkStatus('simkl', wantSimkl)],
  ];
  const missing = statuses
    .filter(([, status]) => status && !status.connected)
    .map(([service]) => SERVICE_LABELS[service]);

  useEffect(() => {
    if (user) {
      setDismissed(localStorage.getItem(dismissKey(user.id)) === '1');
    }
  }, [user]);

  if (!user || dismissed || missing.length === 0) {
    return null;
  }

  return (
    <div className="mt-4 flex flex-col gap-3 rounded-lg bg-gray-800/60 px-4 py-3 ring-1 ring-gray-700 sm:flex-row sm:items-center">
      <LinkIcon className="hidden h-6 w-6 flex-none text-indigo-400 sm:block" />
      <p className="flex-1 text-sm text-gray-300">
        {intl.formatMessage(messages.hint, {
          services: intl.formatList(missing, { type: 'conjunction' }),
        })}
      </p>
      <div className="flex items-center gap-2">
        <LinkButton
          to="/profile/settings/linked-accounts"
          buttonType="primary"
          buttonSize="sm"
        >
          <LinkIcon />
          <span>{intl.formatMessage(messages.linkedAccounts)}</span>
        </LinkButton>
        <button
          type="button"
          className="rounded-md p-1 text-gray-400 transition hover:bg-gray-700 hover:text-white"
          aria-label={intl.formatMessage(messages.dismiss)}
          onClick={() => {
            localStorage.setItem(dismissKey(user.id), '1');
            setDismissed(true);
          }}
        >
          <XMarkIcon className="h-5 w-5" />
        </button>
      </div>
    </div>
  );
};

export default DiscoverLinkHint;
