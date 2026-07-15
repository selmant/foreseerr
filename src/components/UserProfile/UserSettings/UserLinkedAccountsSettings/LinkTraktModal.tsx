import Modal from '@app/components/Common/Modal';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import axios from 'axios';
import { useRouter } from 'next/router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages(
  'components.UserProfile.UserSettings.LinkTraktModal',
  {
    title: 'Link Trakt Account',
    instructions:
      'Enter this code at <VerificationLink>{url}</VerificationLink> to authorize {applicationName}.',
    waiting: 'Waiting for authorization…',
    success: 'Trakt account linked as {username}.',
    expired: 'The code expired. Close this dialog and try again.',
    denied: 'Authorization was denied.',
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
  const { user } = useUser({ id: Number(router.query.userId) });
  const [device, setDevice] = useState<DeviceCodeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<
    'loading' | 'polling' | 'success' | 'error'
  >('loading');
  const [username, setUsername] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deadline = useRef<number>(0);

  const clearPoll = () => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  };

  const poll = useCallback(
    async (deviceCode: string, intervalSeconds: number) => {
      if (!user?.id) return;
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

        if (response.status === 200) {
          setUsername(response.data.username ?? null);
          setStatus('success');
          onSave();
          return;
        }
        if (response.status === 202) {
          pollTimer.current = setTimeout(
            () => poll(deviceCode, intervalSeconds),
            Math.max(intervalSeconds, 5) * 1000
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
          setError(intl.formatMessage(messages.denied));
          return;
        }
        setStatus('error');
        setError(response.data?.message || intl.formatMessage(messages.error));
      } catch {
        setStatus('error');
        setError(intl.formatMessage(messages.error));
      }
    },
    [intl, onSave, user?.id]
  );

  useEffect(() => {
    if (!show || !user?.id) {
      return;
    }

    let cancelled = false;
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
        window.open(data.verification_url, '_blank', 'noopener,noreferrer');
        pollTimer.current = setTimeout(
          () => poll(data.device_code, data.interval),
          Math.max(data.interval, 5) * 1000
        );
      } catch (e) {
        if (cancelled) return;
        setStatus('error');
        const message =
          axios.isAxiosError(e) && e.response?.data?.message
            ? e.response.data.message
            : intl.formatMessage(
                settings.currentSettings.traktConfigured
                  ? messages.error
                  : messages.notConfigured
              );
        setError(message);
      }
    };

    void start();

    return () => {
      cancelled = true;
      clearPoll();
    };
  }, [show, user?.id, intl, poll, settings.currentSettings.traktConfigured]);

  if (!show) {
    return null;
  }

  return (
    <Modal
      title={intl.formatMessage(messages.title)}
      onCancel={onClose}
      cancelText={status === 'success' ? undefined : undefined}
      onOk={status === 'success' ? onClose : undefined}
      okText={status === 'success' ? 'Done' : undefined}
      loading={status === 'loading'}
    >
      {error && <p className="text-red-400">{error}</p>}
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
              url: device.verification_url,
              applicationName: settings.currentSettings.applicationTitle,
              VerificationLink: (msg: React.ReactNode) => (
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
  );
};

export default LinkTraktModal;
