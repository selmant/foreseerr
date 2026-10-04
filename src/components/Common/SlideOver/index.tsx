/* eslint-disable jsx-a11y/click-events-have-key-events */
import { useLockBodyScroll } from '@app/hooks/useLockBodyScroll';
import { Transition, TransitionChild } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { FocusScope } from 'react-aria';
import ReactDOM from 'react-dom';

interface SlideOverProps {
  show?: boolean;
  title: React.ReactNode;
  subText?: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
  navigation?: React.ReactNode;
  maxWidth?: 'md' | 'xl';
}

const SlideOver = ({
  show = false,
  title,
  subText,
  onClose,
  children,
  footer,
  navigation,
  maxWidth = 'md',
}: SlideOverProps) => {
  const [isMounted, setIsMounted] = useState(false);
  const slideoverRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useLockBodyScroll(show);

  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Move focus into the panel so Escape and Tab work without a click first.
  // FocusScope restores the opener after the closing transition unmounts.
  useEffect(() => {
    if (!show || !isMounted) {
      return undefined;
    }
    const frame = window.requestAnimationFrame(() =>
      slideoverRef.current?.focus({ preventScroll: true })
    );
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [isMounted, show]);

  if (!isMounted) {
    return null;
  }

  return ReactDOM.createPortal(
    <Transition
      as={Fragment}
      show={show}
      appear
      enter="transition-opacity ease-in-out duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity ease-in-out duration-500 sm:duration-700"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
    >
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
      <div
        className={`fixed inset-0 z-50 overflow-hidden bg-gray-800/70`}
        onClick={() => onClose()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="absolute inset-0 overflow-hidden">
          <section className="absolute inset-y-0 right-0 flex max-w-full">
            <TransitionChild
              as="div"
              enter="transition-transform ease-in-out duration-500 sm:duration-700"
              enterFrom="translate-x-full"
              enterTo="translate-x-0"
              leave="transition-transform ease-in-out duration-500 sm:duration-700"
              leaveFrom="translate-x-0"
              leaveTo="translate-x-full"
            >
              <FocusScope contain restoreFocus>
                {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
                <div
                  className={`slideover relative h-full w-screen p-2 focus:outline-none sm:p-3 ${maxWidth === 'xl' ? 'max-w-xl' : 'max-w-md'}`}
                  ref={slideoverRef}
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby={titleId}
                  tabIndex={-1}
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex h-full flex-col rounded-lg bg-gray-800/80 shadow-xl ring-1 ring-gray-700 backdrop-blur">
                    <header className="space-y-1 border-b border-gray-700 px-4 py-4">
                      <div className="flex items-center justify-between space-x-3">
                        <h2
                          id={titleId}
                          className="text-overseerr text-2xl font-bold leading-7"
                        >
                          {title}
                        </h2>
                        <div className="flex shrink-0 items-center">
                          <button
                            aria-label="Close panel"
                            className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-200 transition duration-150 ease-in-out hover:bg-gray-700 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                            onClick={() => onClose()}
                          >
                            <XMarkIcon className="h-6 w-6" />
                          </button>
                        </div>
                      </div>
                      {subText && (
                        <div>
                          <p className="font-semibold leading-5 text-gray-300">
                            {subText}
                          </p>
                        </div>
                      )}
                      {navigation}
                    </header>
                    <div className="hide-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto">
                      <div className="flex-1 px-4 py-6 text-white">
                        {children}
                      </div>
                    </div>
                    {footer ? (
                      <div className="shrink-0 border-t border-gray-700 px-4 py-4 text-white">
                        {footer}
                      </div>
                    ) : null}
                  </div>
                </div>
              </FocusScope>
            </TransitionChild>
          </section>
        </div>
      </div>
    </Transition>,
    document.body
  );
};

export default SlideOver;
