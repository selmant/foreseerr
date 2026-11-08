import { aiErrorOf } from '@app/components/Ai/aiError';
import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import { SmallLoadingSpinner } from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
} from '@heroicons/react/24/solid';
import type { AiErrorBody, AiMe } from '@shared/interfaces/api/aiInterfaces';
import axios from 'axios';
import { forwardRef, useCallback, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages(
  'components.UserProfile.UserSettings.UserAiSettings.ChatgptConnectModal',
  {
    title: 'Connect ChatGPT',
    intro: 'Foreseerr will use your ChatGPT plan for your own requests.',
    pointUsage: 'They count toward your plan’s usage limits, like Codex does.',
    pointPersonal:
      'Only you can use this connection. Nobody else on this server can, admins included.',
    pointManage:
      'You can review usage, set a limit, or remove Foreseerr in ChatGPT settings at any time.',
    addressHeadsUp:
      'After you approve, ChatGPT sends you to an address starting with {address}. That page won’t load. That’s expected: copy its address and come back here.',
    continue: 'Continue with ChatGPT',
    pasteTitle: 'Paste the address',
    pasteHint:
      'Copy the whole address from the tab that didn’t load and paste it here. It works once, for a few minutes.',
    pasteLabel: 'Address from the sign-in tab',
    finish: 'Finish connecting',
    finishing: 'Connecting…',
    openAgain: 'Open ChatGPT again',
    startAgain: 'Start again',
    doneTitle: 'You’re using your ChatGPT plan',
    doneSignedIn: 'Signed in as {email}.',
    doneBody:
      'Your Foreseerr requests now count toward your ChatGPT plan’s limits. Nobody else can use this connection.',
    doneNoPlan:
      'ChatGPT signed you in, but plan use isn’t available for this account or workspace. Ask your workspace admin, or switch back to the server connection.',
    manageUsage: 'Manage usage in ChatGPT',
    done: 'Done',
  }
);

type Step = 'intro' | 'paste' | 'done';

type ChatgptConnectModalProps = {
  redirectUri: string;
  onClose: () => void;
  onConnected: (me: AiMe) => void;
};

const ChatgptConnectModal = forwardRef<
  HTMLDivElement,
  ChatgptConnectModalProps
>(({ redirectUri, onClose, onConnected }, ref) => {
  const intl = useIntl();
  const [step, setStep] = useState<Step>('intro');
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [pasted, setPasted] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<AiErrorBody | null>(null);
  const [result, setResult] = useState<AiMe | null>(null);

  const start = useCallback(async () => {
    setStarting(true);
    setError(null);
    try {
      const res = await axios.post<{ authorizeUrl: string }>(
        '/api/v1/ai/me/chatgpt/start',
        {}
      );
      setAuthorizeUrl(res.data.authorizeUrl);
    } catch (e) {
      setError(aiErrorOf(e, intl.formatMessage(globalMessages.error)));
    } finally {
      setStarting(false);
    }
  }, [intl]);

  useEffect(() => {
    void start();
  }, [start]);

  const finish = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await axios.post<AiMe>('/api/v1/ai/me/chatgpt/complete', {
        callbackUrl: pasted.trim(),
      });
      setResult(res.data);
      setStep('done');
      onConnected(res.data);
    } catch (e) {
      setError(aiErrorOf(e, intl.formatMessage(globalMessages.error)));
    } finally {
      setSubmitting(false);
    }
  };

  const restart = () => {
    setPasted('');
    setStep('intro');
    void start();
  };

  const signInLink = (label: string, primary: boolean) =>
    authorizeUrl ? (
      <Button
        as="a"
        href={authorizeUrl}
        target="_blank"
        rel="noopener noreferrer"
        buttonType={primary ? 'primary' : 'default'}
        className="min-h-11"
        onClick={() => setStep('paste')}
      >
        <span>{label}</span>
        <ArrowTopRightOnSquareIcon className="ml-2 h-4 w-4" />
      </Button>
    ) : null;

  if (step === 'done' && result) {
    const email = result.own?.accountEmail;
    const usageUrl = result.own?.manageUsageUrl;
    return (
      <Modal
        ref={ref}
        title={intl.formatMessage(messages.doneTitle)}
        onOk={onClose}
        okText={intl.formatMessage(messages.done)}
      >
        <div className="flex items-start gap-3">
          <CheckCircleIcon className="h-8 w-8 shrink-0 text-green-400" />
          <div className="space-y-2 text-gray-300">
            {email ? (
              <p className="font-semibold text-white">
                {intl.formatMessage(messages.doneSignedIn, { email })}
              </p>
            ) : null}
            <p>{intl.formatMessage(messages.doneBody)}</p>
            {result.planEnabled === false ? (
              <Alert
                type="warning"
                title={intl.formatMessage(messages.doneNoPlan)}
              />
            ) : null}
            {usageUrl ? (
              <a
                href={usageUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-indigo-300 hover:underline"
              >
                {intl.formatMessage(messages.manageUsage)}
                <ArrowTopRightOnSquareIcon className="h-4 w-4" />
              </a>
            ) : null}
          </div>
        </div>
      </Modal>
    );
  }

  if (step === 'paste') {
    return (
      <Modal
        ref={ref}
        title={intl.formatMessage(messages.pasteTitle)}
        backgroundClickable={false}
        onCancel={onClose}
        onOk={finish}
        okText={intl.formatMessage(
          submitting ? messages.finishing : messages.finish
        )}
        okDisabled={submitting || pasted.trim() === ''}
      >
        <p className="text-gray-300">
          {intl.formatMessage(messages.pasteHint)}
        </p>
        <label htmlFor="chatgpt-callback" className="mt-4">
          {intl.formatMessage(messages.pasteLabel)}
        </label>
        <input
          id="chatgpt-callback"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={pasted}
          placeholder={`${redirectUri}?code=…`}
          onChange={(e) => setPasted(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && pasted.trim() && !submitting) {
              e.preventDefault();
              void finish();
            }
          }}
        />
        {error ? (
          <div className="mt-4">
            <Alert type="error" title={error.message} />
          </div>
        ) : null}
        <div className="mt-4">
          {/* A failed attempt is usually used up, so after an error only a
              fresh start works. */}
          {error ? (
            <Button type="button" className="min-h-11" onClick={restart}>
              <ArrowPathIcon className="mr-2 h-4 w-4" />
              <span>{intl.formatMessage(messages.startAgain)}</span>
            </Button>
          ) : (
            signInLink(intl.formatMessage(messages.openAgain), false)
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      ref={ref}
      title={intl.formatMessage(messages.title)}
      backgroundClickable={false}
      onCancel={onClose}
    >
      <p className="font-semibold text-white">
        {intl.formatMessage(messages.intro)}
      </p>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-gray-300">
        <li>{intl.formatMessage(messages.pointUsage)}</li>
        <li>{intl.formatMessage(messages.pointPersonal)}</li>
        <li>{intl.formatMessage(messages.pointManage)}</li>
      </ul>
      <p className="mt-4 text-sm text-gray-400">
        {intl.formatMessage(messages.addressHeadsUp, {
          address: (
            <code className="rounded bg-gray-900 px-1 py-0.5 text-gray-200">
              {redirectUri.replace(/\/auth\/callback$/, '')}
            </code>
          ),
        })}
      </p>
      {error ? (
        <div className="mt-4">
          <Alert type="error" title={error.message} />
        </div>
      ) : null}
      <div className="mt-6">
        {starting ? (
          <SmallLoadingSpinner />
        ) : (
          signInLink(intl.formatMessage(messages.continue), true)
        )}
      </div>
    </Modal>
  );
});

ChatgptConnectModal.displayName = 'ChatgptConnectModal';

export default ChatgptConnectModal;
