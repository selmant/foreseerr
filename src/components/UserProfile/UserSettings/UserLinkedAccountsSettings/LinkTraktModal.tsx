import Modal from '@app/components/Common/Modal';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import axios from 'axios';
import { useRouter } from 'next/router';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages(
  'components.UserProfile.UserSettings.LinkTraktModal',
  {
    title: 'Link Trakt Account',
    instructions:
      'Enter this code at <VerificationLink>trakt.tv/activate</VerificationLink> to authorize {applicationName}.',
    waiting: 'Waiting for authorization…',
    success: 'Trakt account linked as {username}.',
    expired: 'The code expired. Close this dialog and try again.',
    denied: 'Authorization was denied.',
    invalid: 'The device code is invalid. Close this dialog and try again.',
    alreadyUsed:
      'This device code was already used. Close this dialog and try again.',
    error: 'Unable to link Trakt account.',
    notConfigured: 'Trakt is not configured by an administrator.',
    yourCode: 'Your code',
  }
);

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

interface LinkTraktModalProps {
  show: boolean;
  onClose: () => void;
  onSave: () => void;
}

const LinkTraktModal = ({ show, onClose, onSave }: LinkTraktModalProps) => {
  const intl = useIntl();
  const settings = useSettings();
  const router = useRouter();
  const routeUserId = Number(router.query.userId);
  const { user: routeUser } = useUser(
    Number.isFinite(routeUserId) && routeUserId > 0
      ? { id: routeUserId }
      : undefined
  );
  const { user: currentUser } = useUser();
  const user = routeUser ?? currentUser;

  const [device, setDevice] = useState<DeviceCodeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<
    'loading' | 'polling' | 'success' | 'error'
  >('loading');
  const [username, setUsername] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deadline = useRef<number>(0);
  const pollGeneration = useRef(0);
  const onSaveRef = useRef(onSave);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  const clearPoll = () => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  };

  const poll = useCallback(
    async (deviceCode: string, intervalSeconds: number, generation: number) => {
      if (!user?.id) return;
      if (generation !== pollGeneration.current) return;
      if (Date.now() > deadline.current) {
        setStatus('error');
        setError(intl.formatMessage(messages.expired));
        return;
      }

      try {
        const response = await axios.post(
          `/api/v1/user/${user.id}/settings/linked-accounts/trakt/device/token`,
          { deviceCode },
          { validateStatus: (s) => s < 500 }
        );

        if (generation !== pollGeneration.current) return;

        if (response.status === 200) {
          setUsername(response.data.username ?? null);
          setStatus('success');
          onSaveRef.current();
          return;
        }
        if (response.status === 202) {
          const retryAfterSeconds = Number(
            response.data?.retryAfterSeconds ?? intervalSeconds
          );
          pollTimer.current = setTimeout(
            () => poll(deviceCode, intervalSeconds, generation),
            Math.max(retryAfterSeconds, intervalSeconds, 5) * 1000
          );
          return;
        }
        if (response.status === 410) {
          setStatus('error');
          setError(intl.formatMessage(messages.expired));
          return;
        }
        if (response.status === 409) {
          setStatus('error');
          setError(
            intl.formatMessage(
              response.data?.status === 'already_used'
                ? messages.alreadyUsed
                : messages.denied
            )
          );
          return;
        }
        if (response.status === 400 && response.data?.status === 'invalid') {
          setStatus('error');
          setError(intl.formatMessage(messages.invalid));
          return;
        }
        const apiMessage = response.data?.message;
        setStatus('error');
        setError(
          typeof apiMessage === 'string'
            ? apiMessage
            : intl.formatMessage(messages.error)
        );
      } catch {
        setStatus('error');
        setError(intl.formatMessage(messages.error));
      }
    },
    [intl, user?.id]
  );

  useEffect(() => {
    if (!show || !user?.id) {
      return;
    }

    let cancelled = false;
    const generation = ++pollGeneration.current;
    clearPoll();
    setDevice(null);
    setError(null);
    setUsername(null);
    setStatus('loading');

    const start = async () => {
      try {
        const { data } = await axios.post<DeviceCodeResponse>(
          `/api/v1/user/${user.id}/settings/linked-accounts/trakt/device/code`
        );
        if (cancelled) return;
        setDevice(data);
        setStatus('polling');
        deadline.current = Date.now() + data.expires_in * 1000;
        pollTimer.current = setTimeout(
          () => poll(data.device_code, data.interval, generation),
          Math.max(data.interval, 5) * 1000
        );
      } catch (e) {
        if (cancelled) return;
        setStatus('error');
        const apiMessage =
          axios.isAxiosError(e) && e.response?.data?.message
            ? e.response.data.message
            : null;
        setError(
          typeof apiMessage === 'string'
            ? apiMessage
            : intl.formatMessage(
                settings.currentSettings.traktConfigured
                  ? messages.error
                  : messages.notConfigured
              )
        );
      }
    };

    void start();

    return () => {
      cancelled = true;
      pollGeneration.current += 1;
      clearPoll();
    };
  }, [show, user?.id, intl, poll, settings.currentSettings.traktConfigured]);

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
        onOk={status === 'success' ? onClose : undefined}
        okText={status === 'success' ? 'Done' : undefined}
        dialogClass="sm:max-w-lg"
      >
        {error && <p className="text-red-400">{error}</p>}
        {status === 'loading' && !error && (
          <p className="text-gray-400">
            {intl.formatMessage(messages.waiting)}
          </p>
        )}
        {status === 'success' && (
          <p className="text-green-400">
            {intl.formatMessage(messages.success, {
              username: username || 'Trakt',
            })}
          </p>
        )}
        {device && status === 'polling' && (
          <div className="space-y-4">
            <p>
              {intl.formatMessage(messages.instructions, {
                applicationName: settings.currentSettings.applicationTitle,
                VerificationLink: (msg: ReactNode) => (
                  <a
                    href={device.verification_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-white underline"
                  >
                    {msg}
                  </a>
                ),
              })}
            </p>
            <div>
              <div className="text-sm text-gray-400">
                {intl.formatMessage(messages.yourCode)}
              </div>
              <div className="mt-1 font-mono text-3xl tracking-widest text-white">
                {device.user_code}
              </div>
            </div>
            <p className="text-sm text-gray-400">
              {intl.formatMessage(messages.waiting)}
            </p>
          </div>
        )}
      </Modal>
    </Transition>
  );
};

export default LinkTraktModal;
