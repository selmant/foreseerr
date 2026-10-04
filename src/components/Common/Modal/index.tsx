import type { ButtonType } from '@app/components/Common/Button';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import useClickOutside from '@app/hooks/useClickOutside';
import { useLockBodyScroll } from '@app/hooks/useLockBodyScroll';
import globalMessages from '@app/i18n/globalMessages';
import { Transition, TransitionChild } from '@headlessui/react';
import type { MouseEvent } from 'react';
import React, { Fragment, useEffect, useId, useRef } from 'react';
import { FocusScope } from 'react-aria';
import ReactDOM from 'react-dom';
import { useIntl } from 'react-intl';

interface ModalProps {
  title?: string;
  subTitle?: string;
  onCancel?: (e?: MouseEvent<HTMLElement>) => void;
  onOk?: (e?: MouseEvent<HTMLButtonElement>) => void;
  onSecondary?: (e?: MouseEvent<HTMLButtonElement>) => void;
  onTertiary?: (e?: MouseEvent<HTMLButtonElement>) => void;
  cancelText?: string;
  okText?: string;
  secondaryText?: string;
  tertiaryText?: string;
  okDisabled?: boolean;
  cancelButtonType?: ButtonType;
  okButtonType?: ButtonType;
  secondaryButtonType?: ButtonType;
  secondaryDisabled?: boolean;
  tertiaryDisabled?: boolean;
  tertiaryButtonType?: ButtonType;
  okButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  cancelButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  secondaryButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  tertiaryButtonProps?: React.ButtonHTMLAttributes<HTMLButtonElement>;
  disableScrollLock?: boolean;
  backgroundClickable?: boolean;
  loading?: boolean;
  backdrop?: string;
  children?: React.ReactNode;
  dialogClass?: string;
  /** Keep actions visible while long dialog content scrolls. */
  stickyActions?: boolean;
  initialFocus?: 'first' | 'cancel';
}

const Modal = React.forwardRef<HTMLDivElement, ModalProps>(
  (
    {
      title,
      subTitle,
      onCancel,
      onOk,
      cancelText,
      okText,
      okDisabled = false,
      cancelButtonType = 'default',
      okButtonType = 'primary',
      children,
      disableScrollLock,
      backgroundClickable = true,
      secondaryButtonType = 'default',
      secondaryDisabled = false,
      onSecondary,
      secondaryText,
      tertiaryButtonType = 'default',
      tertiaryDisabled = false,
      tertiaryText,
      loading = false,
      onTertiary,
      backdrop,
      dialogClass,
      stickyActions = false,
      initialFocus = 'first',
      okButtonProps,
      cancelButtonProps,
      secondaryButtonProps,
      tertiaryButtonProps,
    },
    parentRef
  ) => {
    const intl = useIntl();
    const headlineId = useId();
    const subtitleId = useId();
    const modalRef = useRef<HTMLDivElement>(null);
    const backgroundClickableRef = useRef(backgroundClickable); // This ref is used to detect state change inside the useClickOutside hook
    useEffect(() => {
      backgroundClickableRef.current = backgroundClickable;
    }, [backgroundClickable]);
    useClickOutside(modalRef, () => {
      if (onCancel && backgroundClickableRef.current) {
        onCancel();
      }
    });
    useLockBodyScroll(true, disableScrollLock);
    useEffect(() => {
      if (!stickyActions || loading || initialFocus !== 'cancel') return;
      const frame = requestAnimationFrame(() => {
        modalRef.current
          ?.querySelector<HTMLButtonElement>(
            '[data-testid="modal-cancel-button"]'
          )
          ?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }, [initialFocus, loading, stickyActions]);

    return ReactDOM.createPortal(
      <TransitionChild
        as="div"
        className="fixed bottom-0 left-0 right-0 top-0 z-50 flex h-full w-full items-center justify-center bg-gray-800/70"
        enter="transition-opacity duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
        ref={parentRef}
      >
        <Transition
          appear
          as={Fragment}
          enter="transition duration-300"
          enterFrom="opacity-0 scale-75"
          enterTo="opacity-100 scale-100"
          leave="transition-opacity duration-300"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
          show={loading}
        >
          <div style={{ position: 'absolute' }}>
            <LoadingSpinner />
          </div>
        </Transition>
        <Transition
          className={`hide-scrollbar relative w-full bg-gray-800 px-4 pb-4 pt-4 text-left align-bottom shadow-xl ring-1 ring-gray-700 transition-all sm:my-8 sm:max-w-3xl sm:rounded-lg sm:align-middle ${stickyActions ? 'flex flex-col overflow-hidden' : 'inline-block overflow-auto'} ${dialogClass ?? ''}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={
            title ? headlineId : subTitle ? subtitleId : undefined
          }
          aria-describedby={title && subTitle ? subtitleId : undefined}
          onKeyDown={(event) => {
            if (
              stickyActions &&
              event.key === 'Escape' &&
              backgroundClickableRef.current &&
              onCancel &&
              (event.target as Element).closest('[role="dialog"]') ===
                event.currentTarget
            ) {
              event.preventDefault();
              event.stopPropagation();
              onCancel();
            }
          }}
          style={{
            maxHeight: 'calc(100% - env(safe-area-inset-top) * 2)',
            paddingBottom: stickyActions
              ? 'max(1rem, env(safe-area-inset-bottom))'
              : undefined,
          }}
          appear
          as="div"
          enter="transition duration-300"
          enterFrom="opacity-0 scale-75"
          enterTo="opacity-100 scale-100"
          leave="transition-opacity duration-300"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
          show={!loading}
          ref={modalRef}
        >
          <FocusScope
            contain={stickyActions}
            // eslint-disable-next-line jsx-a11y/no-autofocus -- Dialogs must move keyboard focus inside and restore it on close.
            autoFocus={stickyActions}
            restoreFocus={stickyActions}
          >
            {backdrop && (
              <div className="absolute left-0 right-0 top-0 z-0 h-64 max-h-full w-full">
                <CachedImage
                  type="tmdb"
                  alt=""
                  src={backdrop}
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  fill
                  priority
                />
                <div
                  className="absolute inset-0"
                  style={{
                    backgroundImage:
                      'linear-gradient(180deg, rgba(31, 41, 55, 0.75) 0%, rgba(31, 41, 55, 1) 100%)',
                  }}
                />
              </div>
            )}
            <div className="relative -mx-4 shrink-0 overflow-x-hidden px-4 pt-0.5 sm:flex sm:items-center">
              <div
                className={`mt-3 truncate text-center text-white sm:mt-0 sm:text-left`}
              >
                {(title || subTitle) && (
                  <div className="flex flex-col space-y-1">
                    {title && (
                      <span
                        className="text-overseerr truncate pb-0.5 text-2xl font-bold leading-6"
                        id={headlineId}
                        data-testid="modal-title"
                      >
                        {title}
                      </span>
                    )}
                    {subTitle && (
                      <span
                        className="truncate text-lg font-semibold leading-6 text-gray-200"
                        id={subtitleId}
                        title={subTitle}
                        data-testid="modal-title"
                      >
                        {subTitle}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
            {children && (
              <div
                className={`relative mt-4 text-sm leading-5 text-gray-300 ${stickyActions ? 'min-h-0 overflow-y-auto overscroll-contain' : ''} ${
                  !(onCancel || onOk || onSecondary || onTertiary) ? 'mb-3' : ''
                }`}
              >
                {children}
              </div>
            )}
            {(onCancel || onOk || onSecondary || onTertiary) && (
              <div
                className={`relative shrink-0 ${stickyActions ? 'mt-4 flex flex-col gap-2 border-t border-gray-700 bg-gray-800 pt-4 sm:flex-row-reverse sm:flex-wrap sm:justify-start [&_button]:min-h-[44px] [&_button]:justify-center' : 'mt-5 flex flex-row-reverse justify-center sm:mt-4 sm:justify-start'}`}
              >
                {typeof onOk === 'function' && (
                  <Button
                    buttonType={okButtonType}
                    onClick={onOk}
                    className={stickyActions ? '' : 'ml-3'}
                    disabled={okDisabled}
                    data-testid="modal-ok-button"
                    {...okButtonProps}
                  >
                    {okText ? okText : 'Ok'}
                  </Button>
                )}
                {typeof onSecondary === 'function' && secondaryText && (
                  <Button
                    buttonType={secondaryButtonType}
                    onClick={onSecondary}
                    className={stickyActions ? '' : 'ml-3'}
                    disabled={secondaryDisabled}
                    data-testid="modal-secondary-button"
                    {...secondaryButtonProps}
                  >
                    {secondaryText}
                  </Button>
                )}
                {typeof onTertiary === 'function' && tertiaryText && (
                  <Button
                    buttonType={tertiaryButtonType}
                    onClick={onTertiary}
                    className={stickyActions ? '' : 'ml-3'}
                    disabled={tertiaryDisabled}
                    {...tertiaryButtonProps}
                  >
                    {tertiaryText}
                  </Button>
                )}
                {typeof onCancel === 'function' && (
                  <Button
                    buttonType={cancelButtonType}
                    onClick={onCancel}
                    className={stickyActions ? '' : 'ml-3 sm:ml-0'}
                    data-testid="modal-cancel-button"
                    {...cancelButtonProps}
                  >
                    {cancelText
                      ? cancelText
                      : intl.formatMessage(globalMessages.cancel)}
                  </Button>
                )}
              </div>
            )}
          </FocusScope>
        </Transition>
      </TransitionChild>,
      document.body
    );
  }
);

Modal.displayName = 'Modal';

export default Modal;
