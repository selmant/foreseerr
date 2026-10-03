import Alert from '@app/components/Common/Alert';
import Modal from '@app/components/Common/Modal';
import useRouteQuery from '@app/hooks/useRouteQuery';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import axios from 'axios';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
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
  const { data: anilistStatus } = useSWR<{
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
    if (!user?.id) {
      return;
    }
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
          status === 'success' ? globalMessages.close : messages.submit
        )}
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
              if (code.trim()) void submit();
            }}
          >
            {error && <Alert type="error">{error}</Alert>}
            {anilistStatus?.expired && !error && (
              <Alert type="warning">
                {intl.formatMessage(messages.expired)}
              </Alert>
            )}
            <p>
              {intl.formatMessage(messages.instructions, {
                applicationName: settings.currentSettings.applicationTitle,
                AuthorizeLink: (msg: ReactNode) => (
                  <a
                    href={anilistStatus?.authorizeUrl ?? '#'}
                    target="_blank"
                    rel="noreferrer"
                    className="text-white underline transition hover:text-gray-200"
                  >
                    {msg}
                  </a>
                ),
              })}
            </p>
            <label htmlFor="anilist-pin" className="text-label mt-4">
              {intl.formatMessage(messages.codeLabel)}
            </label>
            <div className="flex rounded-md shadow-sm">
              <input
                id="anilist-pin"
                type="text"
                autoComplete="off"
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
