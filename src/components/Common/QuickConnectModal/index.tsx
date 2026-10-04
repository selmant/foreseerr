import Alert from '@app/components/Common/Alert';
import DeviceCodePanel from '@app/components/Common/DeviceCodePanel';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import { useQuickConnect } from '@app/hooks/useQuickConnect';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Common.QuickConnectModal', {
  waitingForAuth: 'Waiting for authorization...',
  expired: 'Code Expired',
  expiredMessage: 'This Quick Connect code has expired. Please try again.',
  error: 'Error',
  tryAgain: 'Try Again',
});

interface QuickConnectModalProps {
  show: boolean;
  title: string;
  subTitle: string;
  cancelText?: string;
  alternativeText?: string;
  onAlternative?: () => void;
  instructionsMessage: string;
  dialogClass?: string;
  showInlineError?: boolean;
  onCancel: () => void;
  onSuccess: () => void;
  onError?: (error: string) => void;
  authenticate: (secret: string) => Promise<void>;
}

const QuickConnectModal = ({
  show,
  title,
  subTitle,
  cancelText,
  alternativeText,
  onAlternative,
  instructionsMessage,
  dialogClass,
  showInlineError,
  onCancel,
  onSuccess,
  onError,
  authenticate,
}: QuickConnectModalProps) => {
  const intl = useIntl();

  const {
    code,
    isLoading,
    hasError,
    isExpired,
    errorMessage,
    initiateQuickConnect,
    cleanup,
  } = useQuickConnect({
    show,
    onSuccess,
    onError,
    authenticate,
  });

  const handleCancel = () => {
    cleanup();
    onCancel();
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
        onCancel={handleCancel}
        title={title}
        subTitle={subTitle}
        cancelText={cancelText}
        stickyActions
        secondaryText={alternativeText}
        onSecondary={
          onAlternative
            ? () => {
                cleanup();
                onAlternative();
              }
            : undefined
        }
        dialogClass={dialogClass}
        {...(hasError || isExpired
          ? {
              okText: intl.formatMessage(messages.tryAgain),
              onOk: initiateQuickConnect,
            }
          : {})}
      >
        {isLoading && (
          <div className="flex flex-col items-center justify-center py-8">
            <LoadingSpinner />
          </div>
        )}

        {!isLoading && !hasError && !isExpired && (
          <DeviceCodePanel
            instructions={instructionsMessage}
            code={code}
            waitingText={intl.formatMessage(messages.waitingForAuth)}
          />
        )}

        {hasError && (
          <div
            role="alert"
            className="flex flex-col items-center space-y-4 py-4"
          >
            {showInlineError ? (
              <Alert type="error">{errorMessage}</Alert>
            ) : (
              <div className="text-center">
                <h3 className="text-lg font-semibold text-red-500">
                  {intl.formatMessage(messages.error)}
                </h3>
                <p className="mt-2 text-gray-300">{errorMessage}</p>
              </div>
            )}
          </div>
        )}

        {isExpired && (
          <div
            role="status"
            className="flex flex-col items-center space-y-4 py-4"
          >
            <div className="text-center">
              <h3 className="text-lg font-semibold text-yellow-500">
                {intl.formatMessage(messages.expired)}
              </h3>
              <p className="mt-2 text-gray-300">
                {intl.formatMessage(messages.expiredMessage)}
              </p>
            </div>
          </div>
        )}
      </Modal>
    </Transition>
  );
};

export default QuickConnectModal;
