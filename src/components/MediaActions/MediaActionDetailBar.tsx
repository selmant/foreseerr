import Button from '@app/components/Common/Button';
import Tooltip from '@app/components/Common/Tooltip';
import { useMediaActionRatingPopover } from '@app/components/MediaActions/RatingPopover';
import { starsToTrakt } from '@app/components/MediaActions/RatingStars';
import WatchTrackingPanel from '@app/components/MediaActions/WatchTrackingPanel';
import { useMediaActions } from '@app/hooks/useMediaActions';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import { hasMediaActionProviderError } from '@app/utils/mediaActions';
import {
  CheckBadgeIcon as CheckBadgeOutline,
  SignalIcon,
  StarIcon as StarOutline,
} from '@heroicons/react/24/outline';
import {
  CheckBadgeIcon as CheckBadgeSolid,
  StarIcon as StarSolid,
} from '@heroicons/react/24/solid';
import { useCallback, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages(
  'components.MediaActions.MediaActionDetailBar',
  {
    markWatched: 'Mark watched',
    markUnwatched: 'Mark unwatched',
    markWatchedButton: 'Mark Watched',
    watched: 'Watched',
    statusLoading: 'Loading watch status…',
    rate: 'Rate',
    ratingLabel: 'Your rating',
    ratingOutOf: '{score}/10',
    changeRating: 'Change rating: {score}/10',
    ratingHint: 'Choose a rating to save',
    actionFailed: 'Could not update watch status. Try again.',
    ratingFailed: 'Could not save your rating. Try again.',
    actionPartial:
      'Updated, but some connected services could not be synchronized.',
    tracking: 'Watch tracking',
    trackingWarning: 'Watch tracking needs attention',
  }
);

interface MediaActionDetailBarProps {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  showLabels?: boolean;
  title?: string;
}

const MediaActionDetailBar = ({
  tmdbId,
  mediaType,
  showLabels = false,
  title,
}: MediaActionDetailBarProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [showTracking, setShowTracking] = useState(false);

  const {
    actionsEnabled,
    canWatch,
    canRate,
    data,
    statusPending,
    busy,
    toggleWatched,
    submitRating,
    capabilities,
    capabilitiesError,
    capabilitiesPending,
    statusError,
    refreshStatus,
  } = useMediaActions({
    tmdbId,
    mediaType,
    enabled: true,
  });

  const notifyFailure = useCallback(() => {
    addToast(intl.formatMessage(messages.actionFailed), {
      appearance: 'error',
      autoDismiss: true,
    });
  }, [addToast, intl]);

  const notifyPartial = useCallback(() => {
    addToast(intl.formatMessage(messages.actionPartial), {
      appearance: 'warning',
      autoDismiss: true,
    });
  }, [addToast, intl]);

  const handleToggleWatched = useCallback(async () => {
    const outcome = await toggleWatched();
    if (!outcome) {
      notifyFailure();
    } else if (outcome === 'partial') {
      notifyPartial();
    }
  }, [notifyFailure, notifyPartial, toggleWatched]);

  const ratingPopover = useMediaActionRatingPopover({
    ratingStars: data?.ratingStars ?? null,
    busy,
    submitRating,
    label: intl.formatMessage(messages.ratingLabel),
    failureMessage: intl.formatMessage(messages.ratingFailed),
    partialMessage: intl.formatMessage(messages.actionPartial),
    scoreClassName: () => 'text-2xl font-semibold text-amber-300',
  });

  const watched = Boolean(data?.watched);
  const trackingNeedsAttention = Boolean(
    statusError ||
    capabilitiesError ||
    hasMediaActionProviderError(data?.providers ?? [])
  );
  const savedStars = data?.ratingStars ?? null;
  const watchedLabel = statusPending
    ? intl.formatMessage(messages.statusLoading)
    : intl.formatMessage(
        watched ? messages.markUnwatched : messages.markWatched
      );

  return (
    <div className="z-40 mr-2 flex flex-wrap items-center gap-2">
      {actionsEnabled && canWatch && (
        <Tooltip content={watchedLabel}>
          <Button
            buttonType="ghost"
            buttonSize="md"
            className={showLabels ? 'min-h-11' : undefined}
            disabled={busy || statusPending}
            aria-pressed={statusPending ? undefined : watched}
            aria-busy={statusPending || busy}
            aria-label={watchedLabel}
            onClick={handleToggleWatched}
          >
            {watched ? (
              <CheckBadgeSolid
                className={`${showLabels ? 'mr-2' : 'mr-0 sm:mr-2'} h-5 w-5 text-emerald-400`}
              />
            ) : (
              <CheckBadgeOutline
                className={`${showLabels ? 'mr-2' : 'mr-0 sm:mr-2'} h-5 w-5`}
              />
            )}
            <span className={showLabels ? undefined : 'hidden sm:inline'}>
              {statusPending
                ? watchedLabel
                : intl.formatMessage(
                    watched ? messages.watched : messages.markWatchedButton
                  )}
            </span>
          </Button>
        </Tooltip>
      )}
      {actionsEnabled && canRate && (
        <div className="relative" ref={ratingPopover.anchorRef}>
          <Tooltip
            content={
              savedStars != null
                ? intl.formatMessage(messages.ratingOutOf, {
                    score: starsToTrakt(savedStars),
                  })
                : intl.formatMessage(messages.rate)
            }
          >
            <Button
              ref={ratingPopover.triggerRef}
              buttonType="ghost"
              buttonSize="md"
              className={showLabels ? 'min-h-11' : undefined}
              aria-label={
                savedStars != null
                  ? intl.formatMessage(messages.changeRating, {
                      score: starsToTrakt(savedStars),
                    })
                  : intl.formatMessage(messages.rate)
              }
              disabled={busy || statusPending}
              aria-haspopup="dialog"
              aria-expanded={ratingPopover.isOpen}
              aria-controls={ratingPopover.popoverId}
              onClick={ratingPopover.toggle}
            >
              {savedStars != null ? (
                <>
                  <StarSolid
                    className={`${showLabels ? 'mr-2' : 'mr-0 sm:mr-2'} h-5 w-5 text-amber-300`}
                  />
                  <span className={showLabels ? undefined : 'hidden sm:inline'}>
                    {intl.formatMessage(messages.ratingOutOf, {
                      score: starsToTrakt(savedStars),
                    })}
                  </span>
                </>
              ) : (
                <>
                  <StarOutline
                    className={`${showLabels ? 'mr-2' : 'mr-0 sm:mr-2'} h-5 w-5`}
                  />
                  <span className={showLabels ? undefined : 'hidden sm:inline'}>
                    {intl.formatMessage(messages.rate)}
                  </span>
                </>
              )}
            </Button>
          </Tooltip>
          {ratingPopover.popover}
        </div>
      )}
      <Button
        type="button"
        buttonType="ghost"
        buttonSize="md"
        className="min-h-11"
        aria-haspopup="dialog"
        aria-expanded={showTracking}
        aria-label={intl.formatMessage(
          trackingNeedsAttention ? messages.trackingWarning : messages.tracking
        )}
        onClick={() => setShowTracking(true)}
      >
        <SignalIcon
          className={trackingNeedsAttention ? 'text-amber-300' : undefined}
        />
        <span>{intl.formatMessage(messages.tracking)}</span>
      </Button>
      <WatchTrackingPanel
        title={title}
        show={showTracking}
        onClose={() => setShowTracking(false)}
        capabilities={capabilities}
        data={data}
        error={capabilitiesError || statusError}
        pending={capabilitiesPending || statusPending}
        onRefresh={refreshStatus}
      />
    </div>
  );
};

export default MediaActionDetailBar;
