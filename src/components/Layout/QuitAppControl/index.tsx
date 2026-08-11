import Modal from '@app/components/Common/Modal';
import { useNativeRuntime } from '@app/context/NativeRuntimeContext';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { PowerIcon } from '@heroicons/react/24/outline';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Layout.QuitAppControl', {
  quit: 'Quit Foreseer',
  quitTitle: 'Quit Foreseer?',
  quitDescription:
    'This closes the desktop app. You can open it again anytime.',
  quitConfirm: 'Quit',
});

const QuitAppControl = () => {
  const intl = useIntl();
  const { canQuit, quit } = useNativeRuntime();
  const [showConfirm, setShowConfirm] = useState(false);

  if (!canQuit) {
    return null;
  }

  return (
    <>
      <button
        type="button"
        className="flex w-full items-center rounded-md px-2 py-2 text-base font-medium leading-6 text-red-400 transition duration-150 ease-in-out hover:bg-red-600/20 hover:text-red-300 focus:bg-red-600/20 focus:outline-none lg:text-lg"
        data-testid="native-quit-app"
        onClick={() => setShowConfirm(true)}
      >
        <PowerIcon className="mr-3 h-6 w-6" />
        {intl.formatMessage(messages.quit)}
      </button>
      <Transition
        as="div"
        enter="transition-opacity duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
        show={showConfirm}
      >
        <Modal
          title={intl.formatMessage(messages.quitTitle)}
          onCancel={() => setShowConfirm(false)}
          onOk={() => {
            setShowConfirm(false);
            quit();
          }}
          okText={intl.formatMessage(messages.quitConfirm)}
          okButtonType="danger"
        >
          {intl.formatMessage(messages.quitDescription)}
        </Modal>
      </Transition>
    </>
  );
};

export default QuitAppControl;
