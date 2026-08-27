import Modal from '@app/components/Common/Modal';
import { Transition } from '@headlessui/react';
import axios from 'axios';
import { useEffect, useRef, useState } from 'react';

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
  const [pin, setPin] = useState<Pin | null>(null);
  const [message, setMessage] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!show || !userId) return;
    let active = true;
    setPin(null);
    setMessage('Starting Simkl authorization…');
    axios
      .post<Pin>(
        `/api/v1/user/${userId}/settings/linked-accounts/simkl/pin/code`
      )
      .then(({ data }) => {
        if (!active) return;
        setPin(data);
        setMessage('Waiting for authorization…');
        const poll = async () => {
          try {
            const response = await axios.post(
              `/api/v1/user/${userId}/settings/linked-accounts/simkl/pin/token`,
              { deviceCode: data.deviceCode },
              { validateStatus: (status) => status < 500 }
            );
            if (!active) return;
            if (response.status === 200) {
              setMessage(
                `Connected as ${response.data.username ?? 'Simkl user'}.`
              );
              onSave();
              return;
            }
            if (response.status === 202) {
              timer.current = setTimeout(poll, data.interval * 1000);
              return;
            }
            setMessage(
              response.data?.message ?? 'Authorization did not complete.'
            );
          } catch {
            setMessage('Unable to complete Simkl authorization.');
          }
        };
        timer.current = setTimeout(poll, data.interval * 1000);
      })
      .catch(() => setMessage('Unable to start Simkl authorization.'));
    return () => {
      active = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [show, userId, onSave]);
  return (
    <Transition as="div" show={show}>
      <Modal
        title="Link Simkl Account"
        onCancel={onClose}
        dialogClass="sm:max-w-lg"
      >
        <p className="text-gray-300">{message}</p>
        {pin && (
          <div className="mt-4 space-y-2">
            <a
              className="text-white underline"
              target="_blank"
              rel="noreferrer"
              href={pin.verificationUri}
            >
              Open Simkl verification
            </a>
            <div className="font-mono text-3xl tracking-widest text-white">
              {pin.userCode}
            </div>
          </div>
        )}
      </Modal>
    </Transition>
  );
};

export default LinkSimklModal;
