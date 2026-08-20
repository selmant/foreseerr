import Button from '@app/components/Common/Button';
import Tooltip from '@app/components/Common/Tooltip';
import { useMediaActionRatingPopover } from '@app/components/MediaActions/RatingPopover';
import { starsToTrakt } from '@app/components/MediaActions/RatingStars';
import { useTitleCardBatch } from '@app/components/TitleCard/TitleCardBatchContext';
import {
  useMediaActions,
  type MediaActionStatusResponse,
} from '@app/hooks/useMediaActions';
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

export type { MediaActionStatusResponse };

interface MediaActionControlsProps {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  enabled: boolean;
  /** Called after watched/rating changes so hide-watched lists can refresh. */
  onStatusChange?: () => void;
}

const messages = defineMessages('components.TitleCard.MediaActionControls', {
  markWatched: 'Not watched · mark watched',
  markUnwatched: 'Watched · mark unwatched',
  statusLoading: 'Loading watch status…',
  rate: 'Rate',
  ratingLabel: 'Your rating',
  ratingOutOf: '{score}/10',
  ratingHint: 'Click a star to save',
  actionFailed: 'Could not update watch status. Try again.',
  actionPartial:
    'Updated on one provider, but another provider could not be synchronized.',
});

const MediaActionControls = ({
  tmdbId,
  mediaType,
  enabled,
  onStatusChange,
}: MediaActionControlsProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const batch = useTitleCardBatch();

  const batchStatus = batch?.getStatus(mediaType, tmdbId);
  const deferToBatch = Boolean(
    batch?.active && (batchStatus != null || batch.isLoading)
  );

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
    enabled,
    externalStatus: batchStatus,
    deferStatusFetch: deferToBatch,
    onStatusChange,
  });

  const stop = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

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

  const handleToggleWatched = useCallback(
    async (e: React.MouseEvent) => {
      stop(e);
      const ok = await toggleWatched();
      if (!ok) {
        notifyFailure();
      } else if (ok === 'partial') {
        notifyPartial();
      }
    },
    [notifyFailure, notifyPartial, stop, toggleWatched]
  );

  const ratingPopover = useMediaActionRatingPopover({
    ratingStars: data?.ratingStars ?? null,
    busy,
    submitRating,
    label: intl.formatMessage(messages.ratingLabel),
    hint: intl.formatMessage(messages.ratingHint),
    failureMessage: intl.formatMessage(messages.actionFailed),
    partialMessage: intl.formatMessage(messages.actionPartial),
    stopPropagation: true,
    scoreClassName: (isHovering) =>
      `text-2xl font-semibold tracking-tight transition-colors ${
        isHovering ? 'text-amber-200' : 'text-amber-300'
      }`,
  });

  if (!enabled || !actionsEnabled) {
    return null;
  }

  const watched = Boolean(data?.watched);
  const savedStars = data?.ratingStars ?? null;
  const hasRating = savedStars != null;

  const watchedTooltip = statusPending
    ? intl.formatMessage(messages.statusLoading)
    : intl.formatMessage(
        watched ? messages.markUnwatched : messages.markWatched
      );

  return (
    <div className="relative flex flex-col items-end gap-1">
      {canWatch && (
        <Tooltip content={watchedTooltip}>
          <Button
            buttonType="ghost"
            className="z-40"
            buttonSize="sm"
            disabled={busy || statusPending}
            aria-pressed={statusPending ? undefined : watched}
            aria-busy={statusPending || busy}
            aria-label={watchedTooltip}
            onClick={handleToggleWatched}
          >
            {statusPending ? (
              <span
                className="inline-block h-3.5 w-3.5 animate-pulse rounded-full border border-white/40 bg-white/10"
                aria-hidden
              />
            ) : watched ? (
              <CheckBadgeSolid
                className="h-3.5 w-3.5 text-emerald-400 drop-shadow-[0_0_4px_rgba(52,211,153,0.55)]"
                aria-hidden
              />
            ) : (
              <CheckBadgeOutline
                className="h-3.5 w-3.5 text-white/75"
                aria-hidden
              />
            )}
          </Button>
        </Tooltip>
      )}
      {canRate && (
        <div className="relative" ref={ratingPopover.anchorRef}>
          <Tooltip
            content={
              hasRating
                ? intl.formatMessage(messages.ratingOutOf, {
                    score: starsToTrakt(savedStars),
                  })
                : intl.formatMessage(messages.rate)
            }
          >
            <Button
              ref={ratingPopover.triggerRef}
              buttonType="ghost"
              className="z-40"
              buttonSize="sm"
              disabled={busy || statusPending}
              aria-haspopup="dialog"
              aria-expanded={ratingPopover.isOpen}
              aria-controls={ratingPopover.popoverId}
              onClick={(e) => {
                stop(e);
                ratingPopover.toggle();
              }}
            >
              {hasRating ? (
                <span className="flex items-center gap-0.5 text-[10px] font-semibold tabular-nums text-amber-300">
                  <StarSolid className="h-3.5 w-3.5" aria-hidden />
                  {starsToTrakt(savedStars)}
                </span>
              ) : (
                <StarOutline
                  className="h-3.5 w-3.5 text-white/75"
                  aria-hidden
                />
              )}
            </Button>
          </Tooltip>
          {ratingPopover.popover}
        </div>
      )}
    </div>
  );
};

export default MediaActionControls;
