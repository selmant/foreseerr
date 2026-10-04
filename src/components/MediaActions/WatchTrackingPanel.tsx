import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LinkButton from '@app/components/Common/LinkButton';
import SlideOver from '@app/components/Common/SlideOver';
import type {
  MediaActionCapabilitiesResponse,
  MediaActionStatusResponse,
} from '@app/hooks/useMediaActions';
import defineMessages from '@app/utils/defineMessages';
import {
  MEDIA_ACTION_PROVIDER_LABELS,
  hasMediaActionProviderError,
  isMediaActionMappingMissing,
} from '@app/utils/mediaActions';
import {
  ArrowPathIcon,
  ChevronDownIcon,
  LinkIcon,
} from '@heroicons/react/24/outline';
import { useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.MediaActions.WatchTrackingPanel', {
  title: 'Watch tracking',
  description: 'Compare watch status and ratings across your enabled services.',
  subtitle: 'Watch status and ratings for this title',
  refresh: 'Refresh status',
  refreshing: 'Refreshing…',
  settings: 'Linked accounts & tracking',
  failed: 'Could not load watch tracking. Refresh to try again.',
  cachedFailure:
    'Could not refresh watch tracking. Previously loaded values are still shown; try again.',
  loading: 'Loading tracking status…',
  none: 'No watch tracking service is enabled. Link an account and enable tracking to use watch status and ratings here.',
  notEnabled: 'Not enabled for your account',
  unavailable: 'Status unavailable. Refresh to try again.',
  noMatch: 'No matching title in this service.',
  watched: 'Watched',
  unwatched: 'Unwatched',
  watchStatus: 'Watch status',
  rating: 'Your rating',
  noRating: 'Not rated',
  score: '{score}/10',
  partial:
    'Some services could not load this title. Other available services can still be used.',
  notMapped:
    'Watch status or rating is unavailable because this title has not been matched to a supporting service.',
  unsupported:
    'Some actions are not supported by the enabled services for this title.',
  combined:
    'The title is shown as watched when any available service reports it as watched. Ratings below may differ between services.',
  enabledServices: 'Enabled services',
  otherServices: 'Other services ({count})',
  loaded: 'Loaded',
  loadingBadge: 'Loading…',
  unmatched: 'Not matched',
  unavailableBadge: 'Unavailable',
  notEnabledBadge: 'Not enabled',
  loadedSummary: '{loaded} of {total} enabled services loaded',
  unmatchedSummary:
    '{count, plural, one {No title match in # service} other {No title match in # services}}',
  unavailableSummary:
    '{count, plural, one {# service unavailable} other {# services unavailable}}',
  watchedAndRating: 'Watch status & ratings',
  watchedOnly: 'Watch status only',
  ratingOnly: 'Ratings only',
  differences: 'Watch status differs between services',
  differencesDescription:
    'Foreseerr shows Watched when any service reports it. Each service keeps its own watch status.',
  ratingsCombined:
    'Each service can keep a different rating. Your rating controls update services that support rating this title.',
});

interface WatchTrackingPanelProps {
  title?: string;
  show: boolean;
  onClose: () => void;
  capabilities?: MediaActionCapabilitiesResponse;
  data?: MediaActionStatusResponse;
  error?: unknown;
  pending: boolean;
  onRefresh: () => Promise<unknown>;
}

const WatchTrackingPanel = ({
  title,
  show,
  onClose,
  capabilities,
  data,
  error,
  pending,
  onRefresh,
}: WatchTrackingPanelProps) => {
  const intl = useIntl();
  const [refreshing, setRefreshing] = useState(false);
  const [showOtherServices, setShowOtherServices] = useState(false);
  const otherServicesId = useId();
  const refreshInFlight = useRef(false);
  const refresh = async () => {
    if (refreshInFlight.current || pending) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    try {
      await onRefresh();
    } catch {
      /* SWR reports the error on the panel. */
    } finally {
      refreshInFlight.current = false;
      setRefreshing(false);
    }
  };
  const unavailable = [data?.actions?.watched, data?.actions?.rating].filter(
    (action) => action?.available === false
  );
  const enabledProviders =
    capabilities?.providers.filter((provider) => provider.linked) ?? [];
  const otherProviders =
    capabilities?.providers.filter((provider) => !provider.linked) ?? [];
  const loadedProviders = enabledProviders.filter((provider) =>
    data?.providers.some(
      (status) => status.provider === provider.id && status.ok
    )
  );
  const unmatchedCount = enabledProviders.filter((provider) =>
    data?.providers.some(
      (status) =>
        status.provider === provider.id &&
        !status.ok &&
        isMediaActionMappingMissing(status.error)
    )
  ).length;
  const unavailableCount =
    enabledProviders.length - loadedProviders.length - unmatchedCount;
  const watchedValues = new Set(
    loadedProviders
      .filter((provider) => provider.capabilities.readWatched)
      .map(
        (provider) =>
          data?.providers.find((status) => status.provider === provider.id)
            ?.watched
      )
      .filter((value) => typeof value === 'boolean')
  );
  const renderProvider = (
    provider: MediaActionCapabilitiesResponse['providers'][number]
  ) => {
    const status = data?.providers.find((p) => p.provider === provider.id);
    const noMatch = isMediaActionMappingMissing(status?.error);
    const loaded = provider.linked && status?.ok;
    return (
      <li
        key={provider.id}
        className="rounded-xl border border-gray-700 bg-gray-900/40 p-3 sm:p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold text-white">
            {MEDIA_ACTION_PROVIDER_LABELS[provider.id] ?? provider.id}
          </h3>
          <Badge
            badgeType={
              !provider.linked
                ? 'dark'
                : loaded
                  ? 'light'
                  : noMatch || pending
                    ? 'primary'
                    : 'warning'
            }
          >
            {intl.formatMessage(
              !provider.linked
                ? messages.notEnabledBadge
                : loaded
                  ? messages.loaded
                  : pending
                    ? messages.loadingBadge
                    : noMatch
                      ? messages.unmatched
                      : messages.unavailableBadge
            )}
          </Badge>
        </div>
        {!provider.linked ? (
          <p className="mt-2 text-sm text-gray-400">
            {intl.formatMessage(messages.notEnabled)}
          </p>
        ) : !loaded ? (
          <p className="mt-2 text-sm text-gray-400">
            {intl.formatMessage(
              pending
                ? messages.loading
                : noMatch
                  ? messages.noMatch
                  : messages.unavailable
            )}
          </p>
        ) : (
          <>
            <p className="mt-1 text-xs text-gray-400">
              {intl.formatMessage(
                provider.capabilities.readWatched
                  ? provider.capabilities.readRating
                    ? messages.watchedAndRating
                    : messages.watchedOnly
                  : messages.ratingOnly
              )}
            </p>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
              {provider.capabilities.readWatched && (
                <div>
                  <dt className="text-gray-400">
                    {intl.formatMessage(messages.watchStatus)}
                  </dt>
                  <dd
                    className={`mt-1 font-medium ${status?.watched ? 'text-emerald-300' : 'text-gray-200'}`}
                  >
                    {intl.formatMessage(
                      status?.watched ? messages.watched : messages.unwatched
                    )}
                  </dd>
                </div>
              )}
              {provider.capabilities.readRating && (
                <div>
                  <dt className="text-gray-400">
                    {intl.formatMessage(messages.rating)}
                  </dt>
                  <dd className="mt-1 font-medium text-amber-300">
                    {status?.ratingStars != null
                      ? intl.formatMessage(messages.score, {
                          score: Math.round(status.ratingStars * 2),
                        })
                      : intl.formatMessage(messages.noRating)}
                  </dd>
                </div>
              )}
            </dl>
          </>
        )}
      </li>
    );
  };
  return (
    <SlideOver
      show={show}
      title={intl.formatMessage(messages.title)}
      subText={title || intl.formatMessage(messages.subtitle)}
      onClose={onClose}
      footer={
        <LinkButton
          to="/profile/settings/linked-accounts#watch-trackers"
          className="min-h-11 w-full justify-center"
        >
          <LinkIcon />
          <span>{intl.formatMessage(messages.settings)}</span>
        </LinkButton>
      }
    >
      <div className="space-y-4">
        <p className="text-sm leading-5 text-gray-300">
          {intl.formatMessage(messages.description)}
        </p>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {data && enabledProviders.length > 0 && (
            <div role="status" className="space-y-1 text-sm">
              <p className="font-medium text-gray-200">
                {intl.formatMessage(messages.loadedSummary, {
                  loaded: loadedProviders.length,
                  total: enabledProviders.length,
                })}
              </p>
              {(unmatchedCount > 0 || unavailableCount > 0) && (
                <p className="text-xs text-gray-400">
                  {[
                    unmatchedCount > 0
                      ? intl.formatMessage(messages.unmatchedSummary, {
                          count: unmatchedCount,
                        })
                      : null,
                    unavailableCount > 0
                      ? intl.formatMessage(messages.unavailableSummary, {
                          count: unavailableCount,
                        })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}
            </div>
          )}
          <Button
            type="button"
            className="min-h-11 min-w-11 px-3 sm:px-4"
            disabled={pending && !refreshing}
            aria-disabled={pending || refreshing}
            aria-busy={pending || refreshing}
            aria-label={intl.formatMessage(
              refreshing ? messages.refreshing : messages.refresh
            )}
            onClick={refresh}
          >
            <ArrowPathIcon
              className={`!mr-0 sm:!mr-2 ${refreshing ? 'animate-spin motion-reduce:animate-none' : ''}`}
              aria-hidden
            />
            <span className="hidden sm:inline">
              {intl.formatMessage(
                refreshing ? messages.refreshing : messages.refresh
              )}
            </span>
          </Button>
        </div>
        {Boolean(error) && (
          <div role="alert">
            <Alert
              type="warning"
              title={intl.formatMessage(
                data ? messages.cachedFailure : messages.failed
              )}
            />
          </div>
        )}
        {pending && (
          <p role="status" className="text-sm text-gray-400">
            {intl.formatMessage(messages.loading)}
          </p>
        )}
        {!pending &&
          capabilities &&
          !capabilities.providers.some((p) => p.linked) && (
            <Alert type="info" title={intl.formatMessage(messages.none)} />
          )}
        {hasMediaActionProviderError(data?.providers ?? []) && (
          <Alert type="warning" title={intl.formatMessage(messages.partial)} />
        )}
        {enabledProviders.length > 0 &&
          unavailable.some(
            (action) =>
              action?.reason === 'not_mapped' ||
              action?.reason === 'unsupported' ||
              action?.reason === 'no_provider'
          ) && (
            <Alert
              type="info"
              title={intl.formatMessage(
                unavailable.some((action) => action?.reason === 'not_mapped')
                  ? messages.notMapped
                  : unavailable.some(
                        (action) => action?.reason === 'no_provider'
                      )
                    ? messages.none
                    : messages.unsupported
              )}
            />
          )}
        {watchedValues.size > 1 && (
          <p role="note" className="text-sm font-medium text-indigo-300">
            {intl.formatMessage(messages.differences)}
          </p>
        )}
        {enabledProviders.length > 0 && (
          <section aria-label={intl.formatMessage(messages.enabledServices)}>
            <h2 className="mb-3 text-sm font-semibold text-gray-300">
              {intl.formatMessage(messages.enabledServices)}
            </h2>
            <ul className="space-y-3">
              {enabledProviders.map(renderProvider)}
            </ul>
          </section>
        )}
        {otherProviders.length > 0 && (
          <section>
            <button
              type="button"
              className="flex min-h-11 w-full items-center justify-between gap-2 rounded-md text-left text-sm font-semibold text-gray-300 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
              aria-expanded={showOtherServices}
              aria-controls={otherServicesId}
              onClick={() => setShowOtherServices((shown) => !shown)}
            >
              <span>
                {intl.formatMessage(messages.otherServices, {
                  count: otherProviders.length,
                })}
              </span>
              <ChevronDownIcon
                className={`h-5 w-5 shrink-0 transition-transform motion-reduce:transition-none ${showOtherServices ? 'rotate-180' : ''}`}
                aria-hidden
              />
            </button>
            <ul
              id={otherServicesId}
              className="mt-3 space-y-3"
              hidden={!showOtherServices}
            >
              {otherProviders.map(renderProvider)}
            </ul>
          </section>
        )}
        {data && (
          <p className="text-sm leading-6 text-gray-400">
            {watchedValues.size > 1 && (
              <>{intl.formatMessage(messages.differencesDescription)} </>
            )}
            {intl.formatMessage(
              watchedValues.size > 1
                ? messages.ratingsCombined
                : messages.combined
            )}
          </p>
        )}
      </div>
    </SlideOver>
  );
};

export default WatchTrackingPanel;
