import Alert from '@app/components/Common/Alert';
import LinkButton from '@app/components/Common/LinkButton';
import Modal from '@app/components/Common/Modal';
import defineMessages from '@app/utils/defineMessages';
import {
  Menu,
  MenuButton,
  MenuItem,
  MenuItems,
  Transition,
} from '@headlessui/react';
import {
  ChevronDownIcon,
  Cog6ToothIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import { Fragment, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages(
  'components.RequestList.RequestItem.ActionsMenu',
  {
    manage: 'Manage',
    actions: 'Actions',
    actionsLabel: 'Request actions for {title}',
    delete: 'Delete request',
    remove: 'Remove from {service}',
    deleteTitle: 'Delete this request?',
    deleteHint:
      'Removes this request from Foreseerr. Downloaded files are kept.',
    removeTitle: 'Remove this title and its files?',
    removeMovieHint:
      'Removes this movie and all its files from {service}. This cannot be undone.',
    removeSeriesHint:
      'Removes this entire series and all its files from {service}, including episodes outside this request. This cannot be undone.',
    removeFiles: 'Remove files',
    working: 'Working…',
    deleteFailed: 'Could not delete this request. Try again.',
    removeFailed: 'Could not remove this title. Try again.',
  }
);

const RequestActionsMenu = ({
  title,
  mediaType,
  tmdbId,
  onDelete,
  onRemove,
}: {
  title: string;
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  onDelete: () => Promise<void>;
  onRemove?: () => Promise<void>;
}) => {
  const intl = useIntl();
  const [action, setAction] = useState<'delete' | 'remove'>('delete');
  const [showConfirm, setShowConfirm] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const service = mediaType === 'movie' ? 'Radarr' : 'Sonarr';
  const chooseAction = (next: 'delete' | 'remove') => {
    setError(false);
    setAction(next);
    setShowConfirm(true);
  };
  const restoreMenuFocus = () => {
    // The opening menu item disappears. Restore its persistent trigger after
    // the dialog's own focus restoration finishes.
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() =>
        menuButtonRef.current?.focus({ preventScroll: true })
      )
    );
  };
  const confirm = async () => {
    setBusy(true);
    setError(false);
    try {
      if (action === 'remove') {
        if (!onRemove) throw new Error('File removal is no longer available');
        await onRemove();
      } else await onDelete();
      setShowConfirm(false);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="grid w-full grid-cols-2 gap-2">
        <LinkButton
          to={`/${mediaType}/${tmdbId}?manage=1`}
          buttonType="ghost"
          className="min-h-11"
        >
          <Cog6ToothIcon aria-hidden="true" />
          <span>{intl.formatMessage(messages.manage)}</span>
        </LinkButton>
        <Menu as="div">
          <MenuButton
            ref={menuButtonRef}
            type="button"
            aria-label={intl.formatMessage(messages.actionsLabel, { title })}
            className="flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-gray-600 bg-gray-800/80 px-3 text-sm font-medium text-gray-200 hover:bg-gray-700 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {intl.formatMessage(messages.actions)}
            <ChevronDownIcon aria-hidden="true" className="h-5 w-5" />
          </MenuButton>
          <MenuItems
            anchor={{ to: 'bottom end', gap: 8 }}
            className="z-[60] w-64 max-w-[calc(100vw-2rem)] rounded-xl border border-gray-600 bg-gray-800 p-1 shadow-xl focus:outline-none"
          >
            <MenuItem>
              <button
                type="button"
                className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-red-300 data-[focus]:bg-gray-700"
                onClick={() => chooseAction('delete')}
              >
                <TrashIcon aria-hidden="true" className="h-5 w-5 shrink-0" />
                {intl.formatMessage(messages.delete)}
              </button>
            </MenuItem>
            {onRemove && (
              <MenuItem>
                <button
                  type="button"
                  className="flex min-h-11 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-red-300 data-[focus]:bg-gray-700"
                  onClick={() => chooseAction('remove')}
                >
                  <TrashIcon aria-hidden="true" className="h-5 w-5 shrink-0" />
                  {intl.formatMessage(messages.remove, { service })}
                </button>
              </MenuItem>
            )}
          </MenuItems>
        </Menu>
      </div>
      <Transition
        show={showConfirm}
        as={Fragment}
        afterLeave={restoreMenuFocus}
      >
        <Modal
          title={intl.formatMessage(
            action === 'remove' ? messages.removeTitle : messages.deleteTitle
          )}
          subTitle={title}
          onCancel={() => {
            if (!busy) setShowConfirm(false);
          }}
          onOk={() => void confirm()}
          okText={intl.formatMessage(
            busy
              ? messages.working
              : action === 'remove'
                ? messages.removeFiles
                : messages.delete
          )}
          okButtonType="danger"
          okDisabled={busy}
          cancelButtonProps={{ disabled: busy }}
          backgroundClickable={!busy}
          stickyActions
          initialFocus="cancel"
        >
          {action && (
            <p className="text-sm leading-relaxed text-gray-300">
              {intl.formatMessage(
                action === 'remove'
                  ? mediaType === 'tv'
                    ? messages.removeSeriesHint
                    : messages.removeMovieHint
                  : messages.deleteHint,
                { service }
              )}
            </p>
          )}
          {error && (
            <Alert
              type="error"
              title={intl.formatMessage(
                action === 'remove'
                  ? messages.removeFailed
                  : messages.deleteFailed
              )}
            />
          )}
        </Modal>
      </Transition>
    </>
  );
};

export default RequestActionsMenu;
