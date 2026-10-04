import Alert from '@app/components/Common/Alert';
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
import { ArrowPathIcon, LinkIcon } from '@heroicons/react/24/outline';
import { useRef, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.MediaActions.WatchTrackingPanel', {
  title: 'Watch tracking',
  description:
    'See the watch status and rating saved by each connected service. Your watch controls update the services enabled for your account.',
  subtitle: 'Watch status and ratings for this title',
  refresh: 'Refresh status',
  refreshing: 'Refreshing…',
  settings: 'Linked accounts & tracking',
  failed: 'Could not load watch tracking. Refresh to try again.',
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
  const refreshButton = useRef<HTMLButtonElement>(null);
  const refresh = async () => {
    const restoreFocus = document.activeElement === refreshButton.current;
    setRefreshing(true);
    try {
      await onRefresh();
    } catch {
      /* SWR reports the error on the panel. */
    } finally {
      setRefreshing(false);
      requestAnimationFrame(() => {
        if (restoreFocus && document.activeElement === document.body)
          refreshButton.current?.focus({ preventScroll: true });
      });
    }
  };
  const unavailable = [data?.actions?.watched, data?.actions?.rating].filter(
    (action) => action?.available === false
  );
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
      <div className="space-y-5">
        <p className="text-sm leading-6 text-gray-300">
          {intl.formatMessage(messages.description)}
        </p>
        <Button
          ref={refreshButton}
          type="button"
          className="min-h-11"
          disabled={pending || refreshing}
          aria-busy={refreshing}
          onClick={refresh}
        >
          <ArrowPathIcon />
          <span>
            {intl.formatMessage(
              refreshing ? messages.refreshing : messages.refresh
            )}
          </span>
        </Button>
        {Boolean(error) && (
          <div role="alert">
            <Alert type="warning" title={intl.formatMessage(messages.failed)} />
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
        {unavailable.some(
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
                : unavailable.some((action) => action?.reason === 'no_provider')
                  ? messages.none
                  : messages.unsupported
            )}
          />
        )}
        <ul className="space-y-3">
          {capabilities?.providers.map((provider) => {
            const status = data?.providers.find(
              (p) => p.provider === provider.id
            );
            const noMatch = isMediaActionMappingMissing(status?.error);
            return (
              <li
                key={provider.id}
                className="rounded-xl border border-gray-700 bg-gray-900/40 p-4"
              >
                <h3 className="font-semibold text-white">
                  {MEDIA_ACTION_PROVIDER_LABELS[provider.id] ?? provider.id}
                </h3>
                {!provider.linked ? (
                  <p className="mt-2 text-sm text-gray-400">
                    {intl.formatMessage(messages.notEnabled)}
                  </p>
                ) : !status?.ok ? (
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
                  <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                    {provider.capabilities.readWatched && (
                      <div>
                        <dt className="text-gray-400">
                          {intl.formatMessage(messages.watchStatus)}
                        </dt>
                        <dd
                          className={`mt-1 font-medium ${status.watched ? 'text-emerald-300' : 'text-gray-200'}`}
                        >
                          {intl.formatMessage(
                            status.watched
                              ? messages.watched
                              : messages.unwatched
                          )}
                        </dd>
                      </div>
                    )}
                    {provider.capabilities.readRating && (
                      <div>
                        <dt className="text-gray-400">
                          {intl.formatMessage(messages.rating)}
                        </dt>
                        <dd className="mt-1 font-medium text-gray-200">
                          {status.ratingStars != null
                            ? intl.formatMessage(messages.score, {
                                score: Math.round(status.ratingStars * 2),
                              })
                            : intl.formatMessage(messages.noRating)}
                        </dd>
                      </div>
                    )}
                  </dl>
                )}
              </li>
            );
          })}
        </ul>
        {data && (
          <p className="text-sm leading-6 text-gray-400">
            {intl.formatMessage(messages.combined)}
          </p>
        )}
      </div>
    </SlideOver>
  );
};

export default WatchTrackingPanel;
