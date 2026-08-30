import TvFocusable from '@app/components/Tv/TvFocusable';
import defineMessages from '@app/utils/defineMessages';
import {
  FocusContext,
  useFocusable,
} from '@noriginmedia/norigin-spatial-navigation';
import { useEffect, type ReactNode } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Tv.TvOverlay', {
  close: 'Close',
});

interface TvOverlayProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
}

const TvOverlay = ({ title, children, onClose }: TvOverlayProps) => {
  const intl = useIntl();
  const { ref, focusKey, focusSelf } = useFocusable<
    Record<string, never>,
    HTMLDivElement
  >({
    focusKey: 'TV_OVERLAY',
    isFocusBoundary: true,
    trackChildren: true,
  });

  useEffect(() => {
    focusSelf();
  }, [focusSelf]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <FocusContext.Provider value={focusKey}>
      <div
        ref={ref}
        className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-8"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="w-full max-w-md rounded-xl bg-gray-900 p-6 ring-1 ring-gray-700">
          <h2 className="mb-4 text-2xl font-semibold text-white">{title}</h2>
          <div className="flex flex-col gap-2">{children}</div>
          <div className="mt-4">
            <TvFocusable onEnterPress={onClose}>
              <button
                type="button"
                className="tv-focus-target min-h-12 w-full rounded-lg bg-gray-800 px-4 text-left text-lg text-white"
                onClick={onClose}
              >
                {intl.formatMessage(messages.close)}
              </button>
            </TvFocusable>
          </div>
        </div>
      </div>
    </FocusContext.Provider>
  );
};

export default TvOverlay;
