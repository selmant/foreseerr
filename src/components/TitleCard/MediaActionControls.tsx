import Button from '@app/components/Common/Button';
import Tooltip from '@app/components/Common/Tooltip';
import { useTitleCardBatch } from '@app/components/TitleCard/TitleCardBatchContext';
import defineMessages from '@app/utils/defineMessages';
import {
  CheckCircleIcon as CheckCircleOutline,
  HandThumbUpIcon as HandThumbUpOutline,
} from '@heroicons/react/24/outline';
import {
  CheckCircleIcon as CheckCircleSolid,
  HandThumbUpIcon as HandThumbUpSolid,
} from '@heroicons/react/24/solid';
import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useIntl } from 'react-intl';
import useSWR, { mutate as globalMutate } from 'swr';

export interface MediaActionStatusResponse {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  watched: boolean;
  rating: number | null;
  ratingStars: number | null;
  providers: {
    provider: string;
    ok: boolean;
    watched: boolean;
    rating: number | null;
    ratingStars: number | null;
    error?: string;
  }[];
}

interface MediaActionControlsProps {
  tmdbId: number;
  mediaType: 'movie' | 'tv';
  enabled: boolean;
  /** Called after watched/rating changes so hide-watched lists can refresh. */
  onStatusChange?: () => void;
}

const messages = defineMessages('components.TitleCard.MediaActionControls', {
  markWatched: 'Mark watched',
  markUnwatched: 'Mark unwatched',
  rate: 'Rate',
  ratingLabel: 'Your rating: {stars}',
});

const STAR_STEPS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5];

const MediaActionControls = ({
  tmdbId,
  mediaType,
  enabled,
  onStatusChange,
}: MediaActionControlsProps) => {
  const intl = useIntl();
  const batch = useTitleCardBatch();
  const [busy, setBusy] = useState(false);
  const [showRate, setShowRate] = useState(false);
  const [draftStars, setDraftStars] = useState(3);
  const [localOverride, setLocalOverride] =
    useState<MediaActionStatusResponse | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const rateButtonRef = useRef<HTMLButtonElement>(null);
  const ratePopoverRef = useRef<HTMLDivElement>(null);
  const [ratePopoverPosition, setRatePopoverPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);

  const statusKey =
    enabled && (mediaType === 'movie' || mediaType === 'tv')
      ? `/api/v1/media-actions/${mediaType}/${tmdbId}/status`
      : null;

  // Inside a grid batch provider: rely on status-batch (and SWR cache seed).
  const { data: swrData, mutate } = useSWR<MediaActionStatusResponse>(
    batch?.active ? null : statusKey,
    {
      revalidateOnFocus: false,
    }
  );
  const data = localOverride ?? batch?.getStatus(mediaType, tmdbId) ?? swrData;

  useEffect(() => {
    setLocalOverride(null);
  }, [tmdbId, mediaType]);

  useEffect(() => {
    if (data?.ratingStars != null) {
      setDraftStars(data.ratingStars);
    }
  }, [data?.ratingStars]);

  useEffect(() => {
    if (!showRate) return;
    const onDocClick = (event: MouseEvent) => {
      if (
        !popoverRef.current?.contains(event.target as Node) &&
        !ratePopoverRef.current?.contains(event.target as Node)
      ) {
        setShowRate(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
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
      if (!batch?.active) {
        await mutate(next, false);
      }
      onStatusChange?.();
    },
    [batch?.active, mutate, onStatusChange, statusKey]
  );

  const toggleWatched = useCallback(
    async (e: React.MouseEvent) => {
      stop(e);
      if (busy || !enabled) return;
      setBusy(true);
      try {
        const action = data?.watched ? 'unwatched' : 'watched';
        const { data: next } = await axios.post<MediaActionStatusResponse>(
          `/api/v1/media-actions/${mediaType}/${tmdbId}/${action}`,
          {}
        );
        await applyNext(next);
      } finally {
        setBusy(false);
      }
    },
    [applyNext, busy, data?.watched, enabled, mediaType, stop, tmdbId]
  );

  const submitRating = useCallback(
    async (stars: number) => {
      if (busy || !enabled) return;
      setBusy(true);
      try {
        const { data: next } = await axios.post<MediaActionStatusResponse>(
          `/api/v1/media-actions/${mediaType}/${tmdbId}/rate`,
          { ratingStars: stars }
        );
        await applyNext(next);
        setShowRate(false);
      } finally {
        setBusy(false);
      }
    },
    [applyNext, busy, enabled, mediaType, tmdbId]
  );

  if (!enabled) {
    return null;
  }

  const watched = Boolean(data?.watched);
  const WatchIcon = watched ? CheckCircleSolid : CheckCircleOutline;

  return (
    <div className="relative flex flex-col items-end gap-1">
      <Tooltip
        content={intl.formatMessage(
          watched ? messages.markUnwatched : messages.markWatched
        )}
      >
        <Button
          buttonType="ghost"
          className="z-40"
          buttonSize="sm"
          disabled={busy}
          onClick={toggleWatched}
        >
          <WatchIcon
            className={`h-3 ${watched ? 'text-green-400' : 'text-white'}`}
          />
        </Button>
      </Tooltip>
      <div className="relative" ref={popoverRef}>
        <Tooltip content={intl.formatMessage(messages.rate)}>
          <Button
            ref={rateButtonRef}
            buttonType="ghost"
            className="z-40"
            buttonSize="sm"
            disabled={busy}
            onClick={(e) => {
              stop(e);
              setShowRate((v) => {
                const next = !v;
                const rect = rateButtonRef.current?.getBoundingClientRect();
                if (next && rect) {
                  const width = 224;
                  const height = 176;
                  const gap = 8;
                  setRatePopoverPosition({
                    top:
                      rect.bottom + gap + height > window.innerHeight
                        ? Math.max(gap, rect.top - height - gap)
                        : rect.bottom + gap,
                    left: Math.min(
                      Math.max(gap, rect.right - width),
                      window.innerWidth - width - gap
                    ),
                  });
                }
                return next;
              });
            }}
          >
            {data?.ratingStars != null ? (
              <HandThumbUpSolid className="h-3 text-amber-300" />
            ) : (
              <HandThumbUpOutline className="h-3 text-white" />
            )}
          </Button>
        </Tooltip>
      </div>
      {showRate &&
        ratePopoverPosition &&
        createPortal(
          <div
            ref={ratePopoverRef}
            role="dialog"
            aria-label={intl.formatMessage(messages.rate)}
            className="fixed z-[100] w-56 rounded-xl border border-white/15 bg-gray-950/95 p-3 text-white shadow-2xl shadow-black/50 backdrop-blur-xl"
            style={ratePopoverPosition}
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <p className="text-[0.62rem] font-semibold uppercase tracking-[0.16em] text-gray-400">
                  Your rating
                </p>
                <p className="mt-1 text-xl font-bold tabular-nums text-amber-300">
                  {draftStars.toFixed(1)}
                  <span className="ml-1 text-xs font-medium text-gray-500">
                    / 5
                  </span>
                </p>
              </div>
              <HandThumbUpSolid className="mt-1 h-5 w-5 text-amber-300" />
            </div>
            <input
              type="range"
              min={0}
              max={STAR_STEPS.length - 1}
              step={1}
              value={Math.max(
                0,
                STAR_STEPS.findIndex((s) => s === draftStars)
              )}
              aria-label={intl.formatMessage(messages.rate)}
              className="h-1.5 w-full cursor-pointer accent-amber-400"
              onChange={(e) => {
                const idx = Number(e.target.value);
                setDraftStars(STAR_STEPS[idx] ?? 3);
              }}
              onMouseUp={(e) => {
                const idx = Number((e.target as HTMLInputElement).value);
                submitRating(STAR_STEPS[idx] ?? draftStars);
              }}
              onTouchEnd={(e) => {
                const idx = Number((e.target as HTMLInputElement).value);
                submitRating(STAR_STEPS[idx] ?? draftStars);
              }}
              onKeyUp={(e) => {
                if (e.key === 'Enter') {
                  const idx = Number((e.target as HTMLInputElement).value);
                  submitRating(STAR_STEPS[idx] ?? draftStars);
                }
              }}
            />
            <div className="mt-1 flex justify-between text-[0.62rem] tabular-nums text-gray-500">
              <span>0.5</span>
              <span>5.0</span>
            </div>
            <p className="mt-3 border-t border-white/10 pt-2 text-[0.62rem] text-gray-500">
              Release the slider to save to Trakt.
            </p>
          </div>,
          document.body
        )}
    </div>
  );
};

export default MediaActionControls;
