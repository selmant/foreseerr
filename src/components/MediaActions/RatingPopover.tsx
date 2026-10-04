import Button from '@app/components/Common/Button';
import {
  nearestStarStep,
  STAR_STEPS,
  starsToTrakt,
} from '@app/components/MediaActions/RatingStars';
import useToasts from '@app/hooks/useToasts';
import defineMessages from '@app/utils/defineMessages';
import type { MediaActionWriteResponse } from '@app/utils/mediaActions';
import { XMarkIcon } from '@heroicons/react/24/outline';
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { FocusScope } from 'react-aria';
import { createPortal } from 'react-dom';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.MediaActions.RatingPopover', {
  close: 'Close rating',
  save: 'Save rating',
  saving: 'Saving…',
  cancel: 'Cancel',
  choose: 'Choose a score from 1–10, then save your rating.',
  keyboardHint:
    'Use arrow keys to move between scores. Home selects 1; End selects 10.',
  unsaved: 'Not saved yet',
  saved: 'Saved rating',
  noRating: 'No rating yet',
});

type MediaActionWriteOutcome = MediaActionWriteResponse['outcome'];

interface UseMediaActionRatingPopoverOptions {
  ratingStars: number | null;
  busy: boolean;
  submitRating: (
    ratingStars: number
  ) => Promise<MediaActionWriteOutcome | false>;
  label: string;
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
  failureMessage,
  partialMessage,
  stopPropagation = false,
  scoreClassName,
}: UseMediaActionRatingPopoverOptions) {
  const { addToast } = useToasts();
  const intl = useIntl();
  const [isOpen, setIsOpen] = useState(false);
  const [draftStars, setDraftStars] = useState<number | null>(ratingStars);
  const [hoverStars, setHoverStars] = useState<number | null>(null);
  const [ratingError, setRatingError] = useState<string | null>(null);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const ratingInFlight = useRef(false);
  const hintId = `${popoverId}-hint`;

  useEffect(() => {
    setDraftStars(ratingStars);
  }, [ratingStars]);

  const close = useCallback((restoreFocus = false) => {
    setIsOpen(false);
    setPosition(null);
    setHoverStars(null);
    if (restoreFocus) {
      requestAnimationFrame(() =>
        (
          triggerRef.current ??
          anchorRef.current?.querySelector<HTMLButtonElement>('button')
        )?.focus({ preventScroll: true })
      );
    }
  }, []);

  const toggle = useCallback(() => {
    setIsOpen((open) => {
      if (open) {
        setPosition(null);
        setHoverStars(null);
      }
      setDraftStars(ratingStars);
      setRatingError(null);
      return !open;
    });
  }, [ratingStars]);

  useLayoutEffect(() => {
    if (!isOpen) {
      return;
    }

    const updatePosition = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;

      const width = 288;
      const height = popoverRef.current?.offsetHeight ?? 200;
      const gap = 8;
      setPosition({
        top: Math.max(
          8,
          Math.min(
            rect.bottom + gap + height <= window.innerHeight - 8
              ? rect.bottom + gap
              : rect.top - height - gap,
            window.innerHeight - height - 8
          )
        ),
        left: Math.max(
          8,
          Math.min(rect.right - width, window.innerWidth - width - 8)
        ),
      });
    };

    updatePosition();
    const frame = requestAnimationFrame(updatePosition);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [isOpen, ratingError]);

  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() => {
      const selected = popoverRef.current?.querySelector<HTMLButtonElement>(
        'button[role="radio"][aria-checked="true"]'
      );
      (
        selected ??
        popoverRef.current?.querySelector<HTMLButtonElement>(
          'button[role="radio"]'
        )
      )?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const onDocumentMouseDown = (event: MouseEvent) => {
      if (busy || ratingInFlight.current) return;
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
        event.stopPropagation();
        if (!busy && !ratingInFlight.current) close(true);
      }
    };

    document.addEventListener('mousedown', onDocumentMouseDown);
    document.addEventListener('keydown', onDocumentKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onDocumentMouseDown);
      document.removeEventListener('keydown', onDocumentKeyDown, true);
    };
  }, [busy, close, isOpen]);

  const handleSubmitRating = useCallback(async () => {
    if (draftStars == null || busy || ratingInFlight.current) return;
    ratingInFlight.current = true;
    setRatingError(null);
    let outcome: MediaActionWriteOutcome | false = false;
    try {
      outcome = await submitRating(draftStars);
    } catch {
      // Keep the selected score available for retry.
    } finally {
      ratingInFlight.current = false;
    }
    if (!outcome || outcome === 'failure') {
      setRatingError(failureMessage);
      requestAnimationFrame(() =>
        saveButtonRef.current?.focus({ preventScroll: true })
      );
      return;
    }
    if (outcome === 'partial') {
      addToast(partialMessage, {
        appearance: 'warning',
        autoDismiss: true,
      });
    }
    close(true);
  }, [
    addToast,
    busy,
    close,
    draftStars,
    failureMessage,
    partialMessage,
    submitRating,
  ]);

  const displayStars = hoverStars ?? draftStars;
  const selectedStep = draftStars == null ? null : starsToTrakt(draftStars) / 2;
  const popover =
    isOpen && position
      ? createPortal(
          <FocusScope contain restoreFocus>
            <div
              ref={popoverRef}
              id={popoverId}
              role="dialog"
              aria-modal="false"
              aria-label={label}
              className="fixed z-[100] max-h-[calc(100dvh-16px)] w-72 max-w-[calc(100vw-16px)] overflow-y-auto overscroll-contain rounded-xl border border-gray-600/80 bg-gray-900/95 p-3 shadow-2xl backdrop-blur-sm"
              style={position}
            >
              <div className="mb-2.5 flex items-center gap-2">
                <span className="text-[10px] font-medium uppercase tracking-wider text-gray-400">
                  {label}
                </span>
                <span className="ml-auto tabular-nums leading-none">
                  <span className={scoreClassName(hoverStars != null)}>
                    {displayStars == null ? '—' : starsToTrakt(displayStars)}
                  </span>
                  <span className="ml-0.5 text-xs text-gray-500">/10</span>
                </span>
                <button
                  type="button"
                  data-rating-close
                  aria-label={intl.formatMessage(messages.close)}
                  disabled={busy}
                  onClick={() => close(true)}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-800 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
                >
                  <XMarkIcon aria-hidden="true" className="h-5 w-5" />
                </button>
              </div>
              <div
                role="radiogroup"
                tabIndex={-1}
                aria-label={label}
                aria-describedby={hintId}
                className="grid grid-cols-5 gap-1"
                onMouseLeave={() => setHoverStars(null)}
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget))
                    setHoverStars(null);
                }}
              >
                {STAR_STEPS.map((stars, index) => (
                  <button
                    key={stars}
                    type="button"
                    data-rating={starsToTrakt(stars)}
                    aria-label={`${starsToTrakt(stars)}/10`}
                    role="radio"
                    aria-checked={selectedStep === stars}
                    tabIndex={
                      selectedStep === stars ||
                      (draftStars == null && index === 0)
                        ? 0
                        : -1
                    }
                    disabled={busy}
                    className={`min-h-11 rounded-lg text-sm font-semibold tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 disabled:cursor-wait disabled:opacity-50 ${selectedStep === stars ? 'bg-amber-400 text-gray-900' : 'bg-gray-800 text-gray-200 hover:bg-gray-700 hover:text-amber-200'}`}
                    onKeyDown={(event) => {
                      if (busy || ratingInFlight.current) return;
                      let next: number;
                      switch (event.key) {
                        case 'ArrowRight':
                          next = (index + 1) % STAR_STEPS.length;
                          break;
                        case 'ArrowLeft':
                          next =
                            (index - 1 + STAR_STEPS.length) % STAR_STEPS.length;
                          break;
                        case 'ArrowDown':
                          next = (index + 5) % STAR_STEPS.length;
                          break;
                        case 'ArrowUp':
                          next =
                            (index - 5 + STAR_STEPS.length) % STAR_STEPS.length;
                          break;
                        case 'Home':
                          next = 0;
                          break;
                        case 'End':
                          next = STAR_STEPS.length - 1;
                          break;
                        default:
                          return;
                      }
                      event.preventDefault();
                      event.stopPropagation();
                      const selected = STAR_STEPS[next];
                      setDraftStars(selected);
                      setHoverStars(selected);
                      setRatingError(null);
                      popoverRef.current
                        ?.querySelector<HTMLButtonElement>(
                          `button[data-rating="${starsToTrakt(selected)}"]`
                        )
                        ?.focus();
                    }}
                    onMouseEnter={() => setHoverStars(stars)}
                    onFocus={() => setHoverStars(stars)}
                    onClick={(event) => {
                      if (stopPropagation) {
                        event.preventDefault();
                        event.stopPropagation();
                      }
                      if (busy || ratingInFlight.current) return;
                      setDraftStars(nearestStarStep(stars));
                      setRatingError(null);
                    }}
                  >
                    {starsToTrakt(stars)}
                  </button>
                ))}
              </div>
              <p
                role="status"
                className="mt-2.5 text-center text-xs text-gray-400"
              >
                {intl.formatMessage(
                  draftStars == null
                    ? messages.noRating
                    : draftStars !== ratingStars
                      ? messages.unsaved
                      : messages.saved
                )}
              </p>
              <p
                id={hintId}
                className="mt-2 text-center text-xs leading-5 text-gray-400"
              >
                {intl.formatMessage(messages.choose)}
                <span className="sr-only">
                  {' '}
                  {intl.formatMessage(messages.keyboardHint)}
                </span>
              </p>
              {ratingError && (
                <p
                  role="alert"
                  className="mt-3 text-center text-sm text-red-300"
                >
                  {ratingError}
                </p>
              )}
              <div className="mt-3 flex gap-2">
                <Button
                  type="button"
                  buttonType="ghost"
                  className="min-h-11 flex-1 justify-center"
                  disabled={busy}
                  onClick={() => close(true)}
                >
                  {intl.formatMessage(messages.cancel)}
                </Button>
                <Button
                  ref={saveButtonRef}
                  type="button"
                  buttonType="primary"
                  className="min-h-11 flex-1 justify-center"
                  disabled={
                    !busy && (draftStars == null || draftStars === ratingStars)
                  }
                  aria-disabled={busy}
                  aria-busy={busy}
                  onClick={() => void handleSubmitRating()}
                >
                  {intl.formatMessage(busy ? messages.saving : messages.save)}
                </Button>
              </div>
            </div>
          </FocusScope>,
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
