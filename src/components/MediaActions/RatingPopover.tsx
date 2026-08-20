import {
  nearestStarStep,
  RatingStar,
  starFillAmount,
  starsToTrakt,
} from '@app/components/MediaActions/RatingStars';
import useToasts from '@app/hooks/useToasts';
import type { MediaActionWriteResponse } from '@app/utils/mediaActions';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

type MediaActionWriteOutcome = MediaActionWriteResponse['outcome'];

interface UseMediaActionRatingPopoverOptions {
  ratingStars: number | null;
  busy: boolean;
  submitRating: (
    ratingStars: number
  ) => Promise<MediaActionWriteOutcome | false>;
  label: string;
  hint: string;
  failureMessage: string;
  partialMessage: string;
  /** Title cards need to keep rating interactions out of the card click target. */
  stopPropagation?: boolean;
  scoreClassName: (isHovering: boolean) => string;
}

/**
 * Shared controller and view for media-action rating popovers. It centralizes
 * popover lifecycle/accessibility semantics while leaving trigger layout to
 * each consuming surface.
 */
export function useMediaActionRatingPopover({
  ratingStars,
  busy,
  submitRating,
  label,
  hint,
  failureMessage,
  partialMessage,
  stopPropagation = false,
  scoreClassName,
}: UseMediaActionRatingPopoverOptions) {
  const { addToast } = useToasts();
  const [isOpen, setIsOpen] = useState(false);
  const [draftStars, setDraftStars] = useState(ratingStars ?? 3);
  const [hoverStars, setHoverStars] = useState<number | null>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const popoverId = useId();

  useEffect(() => {
    if (ratingStars != null) {
      setDraftStars(ratingStars);
    }
  }, [ratingStars]);

  const close = useCallback((restoreFocus = false) => {
    setIsOpen(false);
    setPosition(null);
    setHoverStars(null);
    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }, []);

  const toggle = useCallback(() => {
    setIsOpen((open) => {
      if (open) {
        setPosition(null);
        setHoverStars(null);
      }
      return !open;
    });
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) {
      return;
    }

    const updatePosition = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;

      const width = 208;
      const gap = 8;
      setPosition({
        top: rect.bottom + gap,
        left: Math.max(
          8,
          Math.min(rect.right - width, window.innerWidth - width - 8)
        ),
      });
    };

    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const onDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        popoverRef.current?.contains(target) ||
        anchorRef.current?.contains(target)
      ) {
        return;
      }
      close();
    };
    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      }
    };

    document.addEventListener('mousedown', onDocumentMouseDown);
    document.addEventListener('keydown', onDocumentKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocumentMouseDown);
      document.removeEventListener('keydown', onDocumentKeyDown);
    };
  }, [close, isOpen]);

  const handleSubmitRating = useCallback(
    async (stars: number) => {
      const previousDraft = draftStars;
      const nextDraft = nearestStarStep(stars);
      setDraftStars(nextDraft);
      const outcome = await submitRating(nextDraft);
      if (!outcome || outcome === 'failure') {
        setDraftStars(previousDraft);
        addToast(failureMessage, {
          appearance: 'error',
          autoDismiss: true,
        });
        return;
      }
      if (outcome === 'partial') {
        addToast(partialMessage, {
          appearance: 'warning',
          autoDismiss: true,
        });
      }
      close();
    },
    [addToast, close, draftStars, failureMessage, partialMessage, submitRating]
  );

  const displayStars = hoverStars ?? draftStars;
  const popover =
    isOpen && position
      ? createPortal(
          <div
            ref={popoverRef}
            id={popoverId}
            role="dialog"
            aria-modal="false"
            aria-label={label}
            className="fixed z-[100] w-52 rounded-xl border border-gray-600/80 bg-gray-900/95 p-3 shadow-2xl backdrop-blur-sm"
            style={position}
          >
            <div className="mb-2.5 flex items-end justify-between gap-2">
              <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
                {label}
              </span>
              <span className="tabular-nums leading-none">
                <span className={scoreClassName(hoverStars != null)}>
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
                  stopPropagation={stopPropagation}
                />
              ))}
            </div>
            <p className="mt-2.5 text-center text-[10px] text-gray-500">
              {hint}
            </p>
          </div>,
          document.body
        )
      : null;

  return {
    anchorRef,
    triggerRef,
    isOpen,
    popoverId,
    toggle,
    popover,
  };
}
