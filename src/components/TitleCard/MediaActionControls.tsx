import Button from '@app/components/Common/Button';
import Tooltip from '@app/components/Common/Tooltip';
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
import { useIntl } from 'react-intl';
import useSWR from 'swr';

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
}: MediaActionControlsProps) => {
  const intl = useIntl();
  const [busy, setBusy] = useState(false);
  const [showRate, setShowRate] = useState(false);
  const [draftStars, setDraftStars] = useState(3);
  const popoverRef = useRef<HTMLDivElement>(null);

  const statusKey =
    enabled && (mediaType === 'movie' || mediaType === 'tv')
      ? `/api/v1/media-actions/${mediaType}/${tmdbId}/status`
      : null;

  const { data, mutate } = useSWR<MediaActionStatusResponse>(statusKey, {
    revalidateOnFocus: false,
  });

  useEffect(() => {
    if (data?.ratingStars != null) {
      setDraftStars(data.ratingStars);
    }
  }, [data?.ratingStars]);

  useEffect(() => {
    if (!showRate) return;
    const onDocClick = (event: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(event.target as Node)
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

  const toggleWatched = useCallback(
    async (e: React.MouseEvent) => {
      stop(e);
      if (busy || !enabled) return;
      setBusy(true);
      try {
        // Distinct backend endpoints; UI is a single toggle.
        const action = data?.watched ? 'unwatched' : 'watched';
        const { data: next } = await axios.post<MediaActionStatusResponse>(
          `/api/v1/media-actions/${mediaType}/${tmdbId}/${action}`,
          {}
        );
        await mutate(next, false);
      } finally {
        setBusy(false);
      }
    },
    [busy, data?.watched, enabled, mediaType, mutate, stop, tmdbId]
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
        await mutate(next, false);
        setShowRate(false);
      } finally {
        setBusy(false);
      }
    },
    [busy, enabled, mediaType, mutate, tmdbId]
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
            buttonType="ghost"
            className="z-40"
            buttonSize="sm"
            disabled={busy}
            onClick={(e) => {
              stop(e);
              setShowRate((v) => !v);
            }}
          >
            {data?.ratingStars != null ? (
              <HandThumbUpSolid className="h-3 text-amber-300" />
            ) : (
              <HandThumbUpOutline className="h-3 text-white" />
            )}
          </Button>
        </Tooltip>
        {showRate && (
          <div className="absolute right-0 top-full z-50 mt-1 w-40 rounded-md border border-gray-600 bg-gray-800 p-2 shadow-lg">
            <label className="mb-1 block text-[10px] uppercase tracking-wide text-gray-300">
              {intl.formatMessage(messages.ratingLabel, {
                stars: draftStars.toFixed(1),
              })}
            </label>
            <input
              type="range"
              min={0}
              max={STAR_STEPS.length - 1}
              step={1}
              value={Math.max(
                0,
                STAR_STEPS.findIndex((s) => s === draftStars)
              )}
              className="w-full accent-amber-400"
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
          </div>
        )}
      </div>
    </div>
  );
};

export default MediaActionControls;
