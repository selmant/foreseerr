import Alert from '@app/components/Common/Alert';
import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import axios from 'axios';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useIntl } from 'react-intl';
import DeviceCodePanel from './DeviceCodePanel';

const messages = defineMessages(
  'components.UserProfile.UserSettings.LinkSimklModal',
  {
    title: 'Link Simkl Account',
    instructions:
      'Enter this code at <VerificationLink>simkl.com/pin</VerificationLink> to authorize {applicationName}.',
    waiting: 'Waiting for authorization…',
    expired: 'The code expired. Try again to get a new one.',
    denied: 'Authorization was denied.',
    error: 'Unable to link Simkl account.',
    tryAgain: 'Try Again',
  }
);

type Pin = {
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
  deviceCode: string;
};

const LinkSimklModal = ({
  show,
  userId,
  onClose,
  onSave,
}: {
  show: boolean;
  userId?: number;
  onClose: () => void;
  onSave: () => void;
}) => {
  const intl = useIntl();
  const settings = useSettings();
  const [pin, setPin] = useState<Pin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The parent passes a new callback on every render; keep polling stable.
  const onSaveRef = useRef(onSave);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    if (!show || !userId) return;
    let active = true;
    setPin(null);
    setError(null);

    const fail = (message?: unknown) =>
      setError(
        typeof message === 'string' && message
          ? message
          : intl.formatMessage(messages.error)
      );

    axios
      .post<Pin>(
        `/api/v1/user/${userId}/settings/linked-accounts/simkl/pin/code`
      )
      .then(({ data }) => {
        if (!active) return;
        setPin(data);
        const poll = async () => {
          try {
            const response = await axios.post(
              `/api/v1/user/${userId}/settings/linked-accounts/simkl/pin/token`,
              { deviceCode: data.deviceCode },
              { validateStatus: (status) => status < 500 }
            );
            if (!active) return;
            if (response.status === 200) {
              onSaveRef.current();
              return;
            }
            if (response.status === 202 || response.status === 429) {
              const retryAfter = Number(
                response.data?.retryAfterSeconds ?? data.interval
              );
              timer.current = setTimeout(
                poll,
                Math.max(retryAfter, data.interval, 1) * 1000
              );
              return;
            }
            if (response.status === 410) {
              setError(intl.formatMessage(messages.expired));
              return;
            }
            if (response.status === 409 && !response.data?.message) {
              setError(intl.formatMessage(messages.denied));
              return;
            }
            fail(response.data?.message);
          } catch (e) {
            if (active)
              fail(axios.isAxiosError(e) && e.response?.data?.message);
          }
        };
        timer.current = setTimeout(poll, data.interval * 1000);
      })
      .catch((e) => {
        if (active) fail(axios.isAxiosError(e) && e.response?.data?.message);
      });

    return () => {
      active = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [show, userId, attempt, intl]);

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
        {...(error
          ? {
              okText: intl.formatMessage(messages.tryAgain),
              onOk: () => setAttempt((value) => value + 1),
            }
          : {})}
        dialogClass="sm:max-w-lg"
      >
        {error ? (
          <Alert type="error">{error}</Alert>
        ) : pin ? (
          <DeviceCodePanel
            code={pin.userCode}
            waitingText={intl.formatMessage(messages.waiting)}
            instructions={intl.formatMessage(messages.instructions, {
              applicationName: settings.currentSettings.applicationTitle,
              VerificationLink: (msg: ReactNode) => (
                <a
                  href={pin.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                  className="text-white underline transition hover:text-gray-200"
                >
                  {msg}
                </a>
              ),
            })}
          />
        ) : (
          <div className="py-8">
            <SmallLoadingSpinner />
          </div>
        )}
      </Modal>
    </Transition>
  );
};

export default LinkSimklModal;
