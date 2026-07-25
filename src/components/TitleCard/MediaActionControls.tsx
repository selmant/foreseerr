import Button from '@app/components/Common/Button';
import Tooltip from '@app/components/Common/Tooltip';
import { useTitleCardBatch } from '@app/components/TitleCard/TitleCardBatchContext';
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
import axios from 'axios';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useIntl } from 'react-intl';
import useSWR, { mutate as globalMutate } from 'swr';

export interface MediaActionStatusResponse {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  watched: boolean;
  rating: number | null;
  ratingStars: number | null;
  outcome?: 'success' | 'partial' | 'failure';
  providers: {
    provider: string;
    ok: boolean;
    watched: boolean;
    rating: number | null;
    ratingStars: number | null;
    error?: string;
  }[];
}

function writeSucceeded(next: MediaActionStatusResponse): boolean {
  if (next.outcome === 'failure') {
    return false;
  }
  if (next.providers.length === 0) {
    return false;
  }
  // Apply when at least one provider succeeded (covers partial multi-provider).
  return next.providers.some((p) => p.ok);
}

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
  actionFailed: 'Could not update on Trakt. Try again.',
});

const STAR_STEPS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5] as const;

function starsToTrakt(stars: number): number {
  return Math.max(1, Math.min(10, Math.round(stars * 2)));
}

function starFillAmount(displayStars: number, index: number): number {
  const remaining = displayStars - index;
  if (remaining >= 1) return 1;
  if (remaining >= 0.5) return 0.5;
  return 0;
}

function nearestStarStep(stars: number): number {
  return STAR_STEPS.reduce((best, step) =>
    Math.abs(step - stars) < Math.abs(best - stars) ? step : best
  );
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
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onPick(halfValue);
        }}
      />
      <button
        type="button"
        aria-label={`${starsToTrakt(fullValue)}/10`}
        disabled={disabled}
        className="absolute inset-y-0 right-0 z-10 w-1/2 cursor-pointer disabled:cursor-wait"
        onMouseEnter={() => onHover(fullValue)}
        onFocus={() => onHover(fullValue)}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onPick(fullValue);
        }}
      />
    </span>
  );
};

const MediaActionControls = ({
  tmdbId,
  mediaType,
  enabled,
  onStatusChange,
}: MediaActionControlsProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const batch = useTitleCardBatch();
  const [busy, setBusy] = useState(false);
  const [showRate, setShowRate] = useState(false);
  const [draftStars, setDraftStars] = useState(3);
  const [hoverStars, setHoverStars] = useState<number | null>(null);
  const [popoverPos, setPopoverPos] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [localOverride, setLocalOverride] =
    useState<MediaActionStatusResponse | null>(null);
  const rateAnchorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const statusKey =
    enabled && (mediaType === 'movie' || mediaType === 'tv')
      ? `/api/v1/media-actions/${mediaType}/${tmdbId}/status`
      : null;

  const batchStatus = batch?.getStatus(mediaType, tmdbId);
  // Own the GET only when the grid is not actively batching, or this card
  // was somehow missing from the batch payload after load finished.
  const deferToBatch = Boolean(
    batch?.active && (batchStatus != null || batch.isLoading)
  );

  const {
    data: swrData,
    isLoading: swrLoading,
    mutate,
  } = useSWR<MediaActionStatusResponse>(deferToBatch ? null : statusKey, {
    revalidateOnFocus: false,
  });
  const data = localOverride ?? batchStatus ?? swrData;
  const statusPending =
    !data && (Boolean(batch?.isLoading) || (!deferToBatch && swrLoading));

  useEffect(() => {
    setLocalOverride(null);
  }, [tmdbId, mediaType]);

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
      const left = Math.max(
        8,
        Math.min(rect.right - width, window.innerWidth - width - 8)
      );
      setPopoverPos({
        top: rect.bottom + gap,
        left,
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
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [showRate]);

  const stop = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const applyNext = useCallback(
    async (next: MediaActionStatusResponse) => {
      setLocalOverride(next);
      if (statusKey) {
        await globalMutate(statusKey, next, { revalidate: false });
      }
      if (!deferToBatch) {
        await mutate(next, false);
      }
      onStatusChange?.();
    },
    [deferToBatch, mutate, onStatusChange, statusKey]
  );

  const notifyFailure = useCallback(() => {
    addToast(intl.formatMessage(messages.actionFailed), {
      appearance: 'error',
      autoDismiss: true,
    });
  }, [addToast, intl]);

  const toggleWatched = useCallback(
    async (e: React.MouseEvent) => {
      stop(e);
      if (busy || !enabled || statusPending || !data) return;
      setBusy(true);
      try {
        const action = data.watched ? 'unwatched' : 'watched';
        const { data: next } = await axios.post<MediaActionStatusResponse>(
          `/api/v1/media-actions/${mediaType}/${tmdbId}/${action}`,
          {}
        );
        if (!writeSucceeded(next)) {
          notifyFailure();
          return;
        }
        await applyNext(next);
      } catch {
        notifyFailure();
      } finally {
        setBusy(false);
      }
    },
    [
      applyNext,
      busy,
      data,
      enabled,
      mediaType,
      notifyFailure,
      statusPending,
      stop,
      tmdbId,
    ]
  );

  const submitRating = useCallback(
    async (stars: number) => {
      if (busy || !enabled) return;
      const previousDraft = draftStars;
      const clamped = nearestStarStep(stars);
      setDraftStars(clamped);
      setBusy(true);
      try {
        const { data: next } = await axios.post<MediaActionStatusResponse>(
          `/api/v1/media-actions/${mediaType}/${tmdbId}/rate`,
          { ratingStars: clamped }
        );
        if (!writeSucceeded(next)) {
          setDraftStars(previousDraft);
          notifyFailure();
          return;
        }
        await applyNext(next);
        setShowRate(false);
      } catch {
        setDraftStars(previousDraft);
        notifyFailure();
      } finally {
        setBusy(false);
      }
    },
    [applyNext, busy, draftStars, enabled, mediaType, notifyFailure, tmdbId]
  );

  if (!enabled) {
    return null;
  }

  const watched = Boolean(data?.watched);
  const displayStars = hoverStars ?? draftStars;
  const displayScore = starsToTrakt(displayStars);
  const savedStars = data?.ratingStars ?? null;
  const hasRating = savedStars != null;

  const watchedTooltip = statusPending
    ? intl.formatMessage(messages.statusLoading)
    : intl.formatMessage(
        watched ? messages.markUnwatched : messages.markWatched
      );

  return (
    <div className="relative flex flex-col items-end gap-1">
      <Tooltip content={watchedTooltip}>
        <Button
          buttonType="ghost"
          className="z-40"
          buttonSize="sm"
          disabled={busy || statusPending}
          aria-pressed={statusPending ? undefined : watched}
          aria-busy={statusPending || busy}
          aria-label={watchedTooltip}
          onClick={toggleWatched}
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
      <div className="relative" ref={rateAnchorRef}>
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
            buttonType="ghost"
            className="z-40"
            buttonSize="sm"
            disabled={busy || statusPending}
            onClick={(e) => {
              stop(e);
              setShowRate((v) => !v);
            }}
          >
            {hasRating ? (
              <span className="flex items-center gap-0.5 text-[10px] font-semibold tabular-nums text-amber-300">
                <StarSolid className="h-3.5 w-3.5" aria-hidden />
                {starsToTrakt(savedStars)}
              </span>
            ) : (
              <StarOutline className="h-3.5 w-3.5 text-white/75" aria-hidden />
            )}
          </Button>
        </Tooltip>
        {showRate &&
          popoverPos &&
          createPortal(
            <div
              ref={popoverRef}
              className="fixed z-[100] w-52 rounded-xl border border-gray-600/80 bg-gray-900/95 p-3 shadow-2xl backdrop-blur-sm"
              style={{ top: popoverPos.top, left: popoverPos.left }}
            >
              <div className="mb-2.5 flex items-end justify-between gap-2">
                <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
                  {intl.formatMessage(messages.ratingLabel)}
                </span>
                <span className="tabular-nums leading-none">
                  <span
                    className={`text-2xl font-semibold tracking-tight transition-colors ${
                      hoverStars != null ? 'text-amber-200' : 'text-amber-300'
                    }`}
                  >
                    {displayScore}
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
                    onPick={submitRating}
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
    </div>
  );
};

export default MediaActionControls;
