import Button from '@app/components/Common/Button';
import Tooltip from '@app/components/Common/Tooltip';
import { useMediaActionRatingPopover } from '@app/components/MediaActions/RatingPopover';
import { starsToTrakt } from '@app/components/MediaActions/RatingStars';
import { useMediaActions } from '@app/hooks/useMediaActions';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import {
  CheckBadgeIcon as CheckBadgeOutline,
  StarIcon as StarOutline,
} from '@heroicons/react/24/outline';
import {
  CheckBadgeIcon as CheckBadgeSolid,
  StarIcon as StarSolid,
} from '@heroicons/react/24/solid';
import { useCallback } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages(
  'components.MediaActions.MediaActionDetailBar',
  {
    markWatched: 'Mark watched',
    markUnwatched: 'Mark unwatched',
    statusLoading: 'Loading watch status…',
    rate: 'Rate',
    ratingLabel: 'Your rating',
    ratingOutOf: '{score}/10',
    ratingHint: 'Click a star to save',
    actionFailed: 'Could not update watch status. Try again.',
    actionPartial:
      'Updated on some connected services. Check the service status for the remaining sync.',
  }
);

interface MediaActionDetailBarProps {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
}

const MediaActionDetailBar = ({
  tmdbId,
  mediaType,
}: MediaActionDetailBarProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();

  const {
    actionsEnabled,
    canWatch,
    canRate,
    data,
    statusPending,
    busy,
    toggleWatched,
    submitRating,
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
    hint: intl.formatMessage(messages.ratingHint),
    failureMessage: intl.formatMessage(messages.actionFailed),
    partialMessage: intl.formatMessage(messages.actionPartial),
    scoreClassName: () => 'text-2xl font-semibold text-amber-300',
  });

  if (!actionsEnabled) {
    return null;
  }

  const watched = Boolean(data?.watched);
  const savedStars = data?.ratingStars ?? null;
  const watchedLabel = statusPending
    ? intl.formatMessage(messages.statusLoading)
    : intl.formatMessage(
        watched ? messages.markUnwatched : messages.markWatched
      );

  return (
    <div className="z-40 mr-2 flex items-center gap-2">
      {canWatch && (
        <Tooltip content={watchedLabel}>
          <Button
            buttonType="ghost"
            buttonSize="md"
            disabled={busy || statusPending}
            aria-pressed={statusPending ? undefined : watched}
            aria-busy={statusPending || busy}
            aria-label={watchedLabel}
            onClick={handleToggleWatched}
          >
            {watched ? (
              <CheckBadgeSolid className="h-5 w-5 text-emerald-400" />
            ) : (
              <CheckBadgeOutline className="h-5 w-5" />
            )}
            <span className="ml-2 hidden sm:inline">{watchedLabel}</span>
          </Button>
        </Tooltip>
      )}
      {canRate && (
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
              disabled={busy || statusPending}
              aria-haspopup="dialog"
              aria-expanded={ratingPopover.isOpen}
              aria-controls={ratingPopover.popoverId}
              onClick={ratingPopover.toggle}
            >
              {savedStars != null ? (
                <>
                  <StarSolid className="h-5 w-5 text-amber-300" />
                  <span className="ml-2 hidden sm:inline">
                    {intl.formatMessage(messages.ratingOutOf, {
                      score: starsToTrakt(savedStars),
                    })}
                  </span>
                </>
              ) : (
                <>
                  <StarOutline className="h-5 w-5" />
                  <span className="ml-2 hidden sm:inline">
                    {intl.formatMessage(messages.rate)}
                  </span>
                </>
              )}
            </Button>
          </Tooltip>
          {ratingPopover.popover}
        </div>
      )}
    </div>
  );
};

export default MediaActionDetailBar;
