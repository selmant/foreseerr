import Button from '@app/components/Common/Button';
import Tooltip from '@app/components/Common/Tooltip';
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
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
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

const STAR_STEPS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5] as const;

function starsToTrakt(stars: number): number {
  return Math.max(1, Math.min(10, Math.round(stars * 2)));
}

function nearestStarStep(stars: number): number {
  return STAR_STEPS.reduce((best, step) =>
    Math.abs(step - stars) < Math.abs(best - stars) ? step : best
  );
}

function starFillAmount(displayStars: number, index: number): number {
  const remaining = displayStars - index;
  if (remaining >= 1) return 1;
  if (remaining >= 0.5) return 0.5;
  return 0;
}

interface RatingStarProps {
  index: number;
  fill: number;
  disabled: boolean;
  onHover: (stars: number) => void;
  onPick: (stars: number) => void;
}

const RatingStar = ({
  index,
  fill,
  disabled,
  onHover,
  onPick,
}: RatingStarProps) => {
  const halfValue = index + 0.5;
  const fullValue = index + 1;

  return (
    <span className="relative inline-flex h-7 w-7 shrink-0">
      <StarOutline className="absolute inset-0 h-7 w-7 text-gray-500" />
      {fill > 0 && (
        <span
          className="absolute inset-0 overflow-hidden"
          style={{ width: `${fill * 100}%` }}
        >
          <StarSolid className="h-7 w-7 text-amber-300" />
        </span>
      )}
      <button
        type="button"
        aria-label={`${starsToTrakt(halfValue)}/10`}
        disabled={disabled}
        className="absolute inset-y-0 left-0 z-10 w-1/2 cursor-pointer disabled:cursor-wait"
        onMouseEnter={() => onHover(halfValue)}
        onFocus={() => onHover(halfValue)}
        onClick={() => onPick(halfValue)}
      />
      <button
        type="button"
        aria-label={`${starsToTrakt(fullValue)}/10`}
        disabled={disabled}
        className="absolute inset-y-0 right-0 z-10 w-1/2 cursor-pointer disabled:cursor-wait"
        onMouseEnter={() => onHover(fullValue)}
        onFocus={() => onHover(fullValue)}
        onClick={() => onPick(fullValue)}
      />
    </span>
  );
};

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
  const [showRate, setShowRate] = useState(false);
  const [draftStars, setDraftStars] = useState(3);
  const [hoverStars, setHoverStars] = useState<number | null>(null);
  const [popoverPos, setPopoverPos] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const rateAnchorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (data?.ratingStars != null) {
      setDraftStars(data.ratingStars);
    }
  }, [data?.ratingStars]);

  useLayoutEffect(() => {
    if (!showRate) {
      setPopoverPos(null);
      setHoverStars(null);
      return;
    }

    const updatePos = () => {
      const rect = rateAnchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = 208;
      const gap = 8;
      setPopoverPos({
        top: rect.bottom + gap,
        left: Math.max(
          8,
          Math.min(rect.right - width, window.innerWidth - width - 8)
        ),
      });
    };

    updatePos();
    window.addEventListener('resize', updatePos);
    window.addEventListener('scroll', updatePos, true);
    return () => {
      window.removeEventListener('resize', updatePos);
      window.removeEventListener('scroll', updatePos, true);
    };
  }, [showRate]);

  useEffect(() => {
    if (!showRate) return;
    const onDocClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        popoverRef.current?.contains(target) ||
        rateAnchorRef.current?.contains(target)
      ) {
        return;
      }
      setShowRate(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowRate(false);
        rateAnchorRef.current?.querySelector('button')?.focus();
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [showRate]);

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

  const handleSubmitRating = useCallback(
    async (stars: number) => {
      const previousDraft = draftStars;
      const clamped = nearestStarStep(stars);
      setDraftStars(clamped);
      const outcome = await submitRating(clamped);
      if (!outcome) {
        setDraftStars(previousDraft);
        notifyFailure();
        return;
      }
      if (outcome === 'partial') {
        notifyPartial();
      }
      setShowRate(false);
    },
    [draftStars, notifyFailure, notifyPartial, submitRating]
  );

  if (!actionsEnabled) {
    return null;
  }

  const watched = Boolean(data?.watched);
  const savedStars = data?.ratingStars ?? null;
  const displayStars = hoverStars ?? draftStars;
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
        <div className="relative" ref={rateAnchorRef}>
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
              buttonType="ghost"
              buttonSize="md"
              disabled={busy || statusPending}
              onClick={() => setShowRate((value) => !value)}
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
          {showRate &&
            popoverPos &&
            createPortal(
              <div
                ref={popoverRef}
                role="dialog"
                aria-label={intl.formatMessage(messages.ratingLabel)}
                className="fixed z-[100] w-52 rounded-xl border border-gray-600/80 bg-gray-900/95 p-3 shadow-2xl backdrop-blur-sm"
                style={popoverPos}
              >
                <div className="mb-2.5 flex items-end justify-between gap-2">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
                    {intl.formatMessage(messages.ratingLabel)}
                  </span>
                  <span className="tabular-nums leading-none">
                    <span className="text-2xl font-semibold text-amber-300">
                      {starsToTrakt(displayStars)}
                    </span>
                    <span className="ml-0.5 text-xs text-gray-500">/10</span>
                  </span>
                </div>
                <div
                  className="flex items-center justify-between px-0.5"
                  onMouseLeave={() => setHoverStars(null)}
                >
                  {[0, 1, 2, 3, 4].map((index) => (
                    <RatingStar
                      key={index}
                      index={index}
                      fill={starFillAmount(displayStars, index)}
                      disabled={busy}
                      onHover={setHoverStars}
                      onPick={handleSubmitRating}
                    />
                  ))}
                </div>
                <p className="mt-2.5 text-center text-[10px] text-gray-500">
                  {intl.formatMessage(messages.ratingHint)}
                </p>
              </div>,
              document.body
            )}
        </div>
      )}
    </div>
  );
};

export default MediaActionDetailBar;
