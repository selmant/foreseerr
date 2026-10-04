import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import Modal from '@app/components/Common/Modal';
import useRouteQuery from '@app/hooks/useRouteQuery';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.UserProfile.UserSettings.LinkAnilistModal',
  {
    title: 'Link AniList Account',
    instructions:
      'Open <AuthorizeLink>AniList</AuthorizeLink>, authorize {applicationName}, then paste the PIN code here.',
    codeLabel: 'Authorization Code',
    codePlaceholder: 'Paste the AniList PIN',
    submit: 'Link AniList',
    submitting: 'Linking AniList…',
    authorize: 'Open AniList',
    loadingAuthorization: 'Preparing AniList authorization…',
    authorizationError: 'Unable to open AniList authorization. Try again.',
    retryAuthorization: 'Retry authorization',
    returnWithCode:
      'After authorizing, return to this dialog and paste the PIN shown by AniList.',
    success: 'AniList account linked as {username}.',
    error: 'Unable to link AniList account.',
    notConfigured: 'AniList is not configured by an administrator.',
    expired: 'Your AniList authorization expired. Link the account again.',
  }
);

interface LinkAnilistModalProps {
  show: boolean;
  onClose: () => void;
  onSave: () => void;
}

const LinkAnilistModal = ({ show, onClose, onSave }: LinkAnilistModalProps) => {
  const intl = useIntl();
  const settings = useSettings();
  const query = useRouteQuery();
  const routeUserId = Number(query.userId);
  const { user: routeUser } = useUser(
    Number.isFinite(routeUserId) && routeUserId > 0
      ? { id: routeUserId }
      : undefined
  );
  const { user: currentUser } = useUser();
  const user = routeUser ?? currentUser;
  const {
    data: anilistStatus,
    error: authorizationError,
    mutate: revalidateAuthorization,
  } = useSWR<{
    connected: boolean;
    expired?: boolean;
    username: string | null;
    authorizeUrl: string | null;
  }>(
    settings.currentSettings.anilistConfigured && user
      ? `/api/v1/user/${user.id}/settings/linked-accounts/anilist`
      : null
  );

  const [code, setCode] = useState('');
  const codeInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success'>(
    'idle'
  );
  const [username, setUsername] = useState<string | null>(null);

  useEffect(() => {
    if (!show) {
      return;
    }
    setCode('');
    setError(null);
    setUsername(null);
    setStatus('idle');
  }, [show]);

  const submit = async () => {
    if (!user?.id || status !== 'idle' || !code.trim()) {
      return;
    }
    // Keep keyboard focus inside when the submit button becomes disabled.
    codeInput.current?.focus();
    setStatus('submitting');
    setError(null);
    try {
      const response = await axios.post(
        `/api/v1/user/${user.id}/settings/linked-accounts/anilist`,
        { code: code.trim() }
      );
      setUsername(response.data.username ?? null);
      setStatus('success');
      onSave();
    } catch (e) {
      setStatus('idle');
      const apiMessage =
        axios.isAxiosError(e) && e.response?.data?.message
          ? e.response.data.message
          : null;
      setError(
        typeof apiMessage === 'string'
          ? apiMessage
          : intl.formatMessage(
              settings.currentSettings.anilistConfigured
                ? messages.error
                : messages.notConfigured
            )
      );
    }
  };

  return (
    <Transition
      as="div"
      appear
      show={show}
      enter="transition-opacity ease-in-out duration-300"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition-opacity ease-in-out duration-300"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
    >
      <Modal
        title={intl.formatMessage(messages.title)}
        onCancel={onClose}
        onOk={status === 'success' ? onClose : submit}
        okDisabled={
          status === 'submitting' || (status !== 'success' && !code.trim())
        }
        okText={intl.formatMessage(
          status === 'success'
            ? globalMessages.close
            : status === 'submitting'
              ? messages.submitting
              : messages.submit
        )}
        okButtonProps={{ 'aria-busy': status === 'submitting' }}
        stickyActions
        dialogClass="sm:max-w-lg"
      >
        {status === 'success' ? (
          <Alert type="info">
            {intl.formatMessage(messages.success, {
              username: username || 'AniList',
            })}
          </Alert>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (status === 'idle' && code.trim()) void submit();
            }}
          >
            {error && <Alert type="error">{error}</Alert>}
            {anilistStatus?.expired && !error && (
              <Alert type="warning">
                {intl.formatMessage(messages.expired)}
              </Alert>
            )}
            <p className="text-gray-300">
              {intl.formatMessage(messages.instructions, {
                applicationName: settings.currentSettings.applicationTitle,
                AuthorizeLink: (msg: ReactNode) => (
                  <span className="font-medium text-white">{msg}</span>
                ),
              })}
            </p>
            <div className="mt-4">
              {anilistStatus?.authorizeUrl ? (
                <Button
                  as="a"
                  href={anilistStatus.authorizeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  buttonType="primary"
                  className="min-h-11"
                >
                  <ArrowTopRightOnSquareIcon />
                  <span>{intl.formatMessage(messages.authorize)}</span>
                </Button>
              ) : authorizationError || anilistStatus ? (
                <div role="status">
                  <p className="text-sm text-yellow-200">
                    {intl.formatMessage(messages.authorizationError)}
                  </p>
                  <Button
                    type="button"
                    className="mt-2 min-h-11"
                    onClick={() =>
                      void revalidateAuthorization().catch(() => undefined)
                    }
                  >
                    {intl.formatMessage(messages.retryAuthorization)}
                  </Button>
                </div>
              ) : (
                <p role="status" className="text-sm text-gray-400">
                  {intl.formatMessage(messages.loadingAuthorization)}
                </p>
              )}
              <p className="mt-3 text-sm leading-6 text-gray-400">
                {intl.formatMessage(messages.returnWithCode)}
              </p>
            </div>
            <label htmlFor="anilist-pin" className="text-label mt-4">
              {intl.formatMessage(messages.codeLabel)}
            </label>
            <div className="flex rounded-md shadow-sm">
              <input
                id="anilist-pin"
                ref={codeInput}
                type="text"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
                readOnly={status === 'submitting'}
                className="min-h-11 min-w-0"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder={intl.formatMessage(messages.codePlaceholder)}
              />
            </div>
          </form>
        )}
      </Modal>
    </Transition>
  );
};

export default LinkAnilistModal;
