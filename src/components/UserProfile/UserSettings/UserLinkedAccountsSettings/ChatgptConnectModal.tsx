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
  ClipboardDocumentIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/solid';
import type { AiErrorBody, AiMe } from '@shared/interfaces/api/aiInterfaces';
import axios from 'axios';
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages(
  'components.UserProfile.UserSettings.UserLinkedAccountsSettings.ChatgptConnectModal',
  {
    title: 'Connect ChatGPT',
    intro: 'Foreseerr will use your ChatGPT plan for your own requests.',
    pointUsage: 'They count toward your plan’s usage limits, like Codex does.',
    pointPersonal:
      'Only you can use this connection. Nobody else on this server can, admins included.',
    pointManage:
      'You can review usage, set a limit, or remove Foreseerr in ChatGPT settings at any time.',
    continue: 'Continue with ChatGPT',
    waitTitle: 'Approve in ChatGPT',
    stepApprove: 'Sign in and approve Foreseerr in the ChatGPT window.',
    stepCopy: 'It then lands on a page that can’t load. That’s expected.',
    stepCopyKeys: 'Copy that page’s address ({keys}).',
    stepCopyTouch: 'Copy that page’s address: tap the address bar, then Copy.',
    stepBack: 'Come back here. Foreseerr picks it up and finishes.',
    mockError: 'This site can’t be reached',
    waiting: 'Waiting for the address…',
    connecting: 'Connecting…',
    paste: 'Paste address',
    pasteHint: 'Or press {keys} anywhere on this page.',
    pasteLabel: 'Or paste it here',
    notTheAddress:
      'That isn’t the address from this sign-in. Copy the address of the ChatGPT window’s last page.',
    clipboardBlocked:
      'Your browser didn’t allow reading the clipboard. Paste the address with {keys} instead.',
    openAgain: 'Open ChatGPT again',
    startAgain: 'Start again',
    doneTitle: 'You’re using your ChatGPT plan',
    doneNoPlanTitle: 'Signed in, but your plan can’t be used',
    doneSignedIn: 'Signed in as {email}.',
    doneBody:
      'Your Foreseerr requests now count toward your ChatGPT plan’s limits. Nobody else can use this connection.',
    doneCloseWindow: 'You can close the ChatGPT window.',
    doneNoPlan:
      'ChatGPT signed you in, but plan use isn’t available for this account or workspace. Ask your workspace admin, or switch back to the server connection.',
    manageUsage: 'Manage usage in ChatGPT',
    done: 'Done',
  }
);

type Step = 'intro' | 'waiting' | 'done';

type ChatgptConnectModalProps = {
  redirectUri: string;
  /** Ask ChatGPT to show the consent screen again (plan use was declined). */
  consent?: boolean;
  onClose: () => void;
  onConnected: (me: AiMe) => void;
};

const isApple = () =>
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

const isTouch = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(pointer: coarse)').matches === true;

/**
 * The `state` of a pasted callback address, or null when the text isn't one.
 * Accepts the address with or without its `http://` scheme.
 */
const callbackState = (text: string, redirectUri: string): string | null => {
  let candidate = text.trim();
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `http://${candidate}`;
  }
  try {
    const url = new URL(candidate);
    const expected = new URL(redirectUri);
    if (
      url.host !== expected.host ||
      url.pathname !== expected.pathname ||
      url.protocol !== expected.protocol
    ) {
      return null;
    }
    return url.searchParams.get('state');
  } catch {
    return null;
  }
};

/** Opens the sign-in as a small window, or a tab where windows aren't used. */
const openSignIn = (url: string) => {
  const width = 520;
  const height = 720;
  const left = Math.max(0, window.screenX + (window.outerWidth - width) / 2);
  const top = Math.max(0, window.screenY + (window.outerHeight - height) / 2);
  // OpenAI's pages cut the opener link anyway (COOP same-origin), so ask for
  // noopener: Foreseerr never needs a handle to the window.
  window.open(
    url,
    'foreseerr-chatgpt',
    `popup,noopener,noreferrer,width=${width},height=${height},left=${left},top=${top}`
  );
};

const ChatgptConnectModal = forwardRef<
  HTMLDivElement,
  ChatgptConnectModalProps
>(({ redirectUri, consent = false, onClose, onConnected }, ref) => {
  const intl = useIntl();
  const [step, setStep] = useState<Step>('intro');
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);
  const [pasted, setPasted] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<AiErrorBody | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [result, setResult] = useState<AiMe | null>(null);
  // Guards against the same address arriving twice (paste plus focus).
  const busy = useRef(false);

  const pasteKeys = isApple() ? '⌘V' : 'Ctrl+V';
  const copyKeys = isApple() ? '⌘L, ⌘C' : 'Ctrl+L, Ctrl+C';
  const expectedState = authorizeUrl
    ? new URL(authorizeUrl).searchParams.get('state')
    : null;

  const start = useCallback(async () => {
    setStarting(true);
    setError(null);
    setHint(null);
    try {
      const res = await axios.post<{ authorizeUrl: string }>(
        '/api/v1/ai/me/chatgpt/start',
        consent ? { consent: true } : {}
      );
      setAuthorizeUrl(res.data.authorizeUrl);
    } catch (e) {
      setError(aiErrorOf(e, intl.formatMessage(globalMessages.error)));
    } finally {
      setStarting(false);
    }
  }, [intl, consent]);

  useEffect(() => {
    void start();
  }, [start]);

  const finish = useCallback(
    async (callbackUrl: string) => {
      if (busy.current) {
        return;
      }
      busy.current = true;
      setSubmitting(true);
      setError(null);
      setHint(null);
      try {
        const res = await axios.post<AiMe>('/api/v1/ai/me/chatgpt/complete', {
          callbackUrl,
        });
        setResult(res.data);
        setStep('done');
        onConnected(res.data);
      } catch (e) {
        setError(aiErrorOf(e, intl.formatMessage(globalMessages.error)));
      } finally {
        busy.current = false;
        setSubmitting(false);
      }
    },
    [intl, onConnected]
  );

  /**
   * Finishes when `text` is this sign-in's callback address. Nothing else is
   * ever sent to the server, so reading the clipboard can't leak what else
   * is on it. `explain` says why a manual paste was ignored.
   */
  const accept = useCallback(
    (text: string, explain: boolean) => {
      const state = callbackState(text, redirectUri);
      if (state && expectedState && state === expectedState) {
        void finish(text.trim());
        return true;
      }
      if (explain && text.trim()) {
        setHint(intl.formatMessage(messages.notTheAddress));
      }
      return false;
    },
    [redirectUri, expectedState, finish, intl]
  );

  // While waiting: Ctrl+V anywhere, and a quiet clipboard check on return
  // when the browser already allows reading it (no permission prompt).
  useEffect(() => {
    if (step !== 'waiting' || error) {
      return;
    }
    const onPaste = (e: ClipboardEvent) => {
      if ((e.target as HTMLElement | null)?.id === 'chatgpt-callback') {
        return; // the field's own onChange handles it
      }
      const text = e.clipboardData?.getData('text') ?? '';
      if (text) {
        e.preventDefault();
        accept(text, true);
      }
    };
    const checkClipboard = async () => {
      if (document.visibilityState !== 'visible' || busy.current) {
        return;
      }
      try {
        const permission = await navigator.permissions?.query({
          name: 'clipboard-read' as PermissionName,
        });
        if (permission?.state !== 'granted') {
          return;
        }
        accept(await navigator.clipboard.readText(), false);
      } catch {
        // Not supported or not allowed; the Paste button still works.
      }
    };
    document.addEventListener('paste', onPaste);
    window.addEventListener('focus', checkClipboard);
    document.addEventListener('visibilitychange', checkClipboard);
    return () => {
      document.removeEventListener('paste', onPaste);
      window.removeEventListener('focus', checkClipboard);
      document.removeEventListener('visibilitychange', checkClipboard);
    };
  }, [step, error, accept]);

  const pasteFromClipboard = async () => {
    setHint(null);
    try {
      accept(await navigator.clipboard.readText(), true);
    } catch {
      setHint(
        intl.formatMessage(messages.clipboardBlocked, { keys: pasteKeys })
      );
    }
  };

  const begin = () => {
    if (!authorizeUrl) {
      return;
    }
    openSignIn(authorizeUrl);
    setStep('waiting');
  };

  const restart = () => {
    setPasted('');
    setStep('intro');
    void start();
  };

  if (step === 'done' && result) {
    const email = result.own?.accountEmail;
    const usageUrl = result.own?.manageUsageUrl;
    const noPlan = result.planEnabled === false;
    return (
      <Modal
        ref={ref}
        title={intl.formatMessage(
          noPlan ? messages.doneNoPlanTitle : messages.doneTitle
        )}
        onOk={onClose}
        okText={intl.formatMessage(messages.done)}
      >
        <div className="flex items-start gap-3">
          {noPlan ? (
            <ExclamationTriangleIcon className="h-8 w-8 shrink-0 text-yellow-400" />
          ) : (
            <CheckCircleIcon className="h-8 w-8 shrink-0 text-green-400" />
          )}
          <div className="space-y-2 text-gray-300">
            {email ? (
              <p className="font-semibold text-white">
                {intl.formatMessage(messages.doneSignedIn, { email })}
              </p>
            ) : null}
            <p>
              {intl.formatMessage(
                noPlan ? messages.doneNoPlan : messages.doneBody
              )}
            </p>
            <p className="text-sm text-gray-400">
              {intl.formatMessage(messages.doneCloseWindow)}
            </p>
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

  if (step === 'waiting') {
    const touch = isTouch();
    return (
      <Modal
        ref={ref}
        title={intl.formatMessage(messages.waitTitle)}
        backgroundClickable={false}
        onCancel={onClose}
      >
        <ol className="space-y-4 text-gray-300">
          <li className="flex gap-3">
            <StepNumber n={1} />
            <span>{intl.formatMessage(messages.stepApprove)}</span>
          </li>
          <li className="flex gap-3">
            <StepNumber n={2} />
            <div className="min-w-0 flex-1 space-y-2">
              <span>
                {intl.formatMessage(messages.stepCopy)}{' '}
                {touch
                  ? intl.formatMessage(messages.stepCopyTouch)
                  : intl.formatMessage(messages.stepCopyKeys, {
                      keys: copyKeys,
                    })}
              </span>
              {/* What the page looks like, so it's recognisable. */}
              <div
                aria-hidden="true"
                className="overflow-hidden rounded-md border border-gray-600 bg-gray-900"
              >
                <div className="flex items-center gap-2 border-b border-gray-700 bg-gray-800 px-2 py-1.5">
                  <span className="flex gap-1">
                    <span className="h-2 w-2 rounded-full bg-gray-600" />
                    <span className="h-2 w-2 rounded-full bg-gray-600" />
                    <span className="h-2 w-2 rounded-full bg-gray-600" />
                  </span>
                  <span className="min-w-0 flex-1 truncate rounded bg-indigo-500/30 px-2 py-0.5 font-mono text-xs text-indigo-100 ring-1 ring-indigo-400">
                    {redirectUri.replace(/^https?:\/\//, '')}?code=…
                  </span>
                </div>
                <div className="px-3 py-2 text-sm text-gray-400">
                  {intl.formatMessage(messages.mockError)}
                </div>
              </div>
            </div>
          </li>
          <li className="flex gap-3">
            <StepNumber n={3} />
            <span>{intl.formatMessage(messages.stepBack)}</span>
          </li>
        </ol>

        <div className="mt-5 rounded-md border border-gray-700 bg-gray-800/60 p-4">
          {error ? (
            <div className="space-y-3">
              <Alert type="error" title={error.message} />
              {/* A failed attempt is usually used up, so after an error only
                  a fresh start works. */}
              <Button type="button" className="min-h-11" onClick={restart}>
                <ArrowPathIcon className="mr-2 h-4 w-4" />
                <span>{intl.formatMessage(messages.startAgain)}</span>
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <div
                className="flex items-center gap-2 text-sm text-gray-300"
                role="status"
              >
                <ArrowPathIcon className="h-4 w-4 shrink-0 animate-spin text-indigo-300" />
                <span>
                  {intl.formatMessage(
                    submitting ? messages.connecting : messages.waiting
                  )}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  buttonType="primary"
                  className="min-h-11"
                  disabled={submitting}
                  onClick={pasteFromClipboard}
                >
                  <ClipboardDocumentIcon className="mr-2 h-4 w-4" />
                  <span>{intl.formatMessage(messages.paste)}</span>
                </Button>
                {!touch ? (
                  <span className="text-sm text-gray-400">
                    {intl.formatMessage(messages.pasteHint, {
                      keys: pasteKeys,
                    })}
                  </span>
                ) : null}
              </div>
              {hint ? <p className="text-sm text-yellow-300">{hint}</p> : null}
              <div>
                <label
                  htmlFor="chatgpt-callback"
                  className="text-sm text-gray-400"
                >
                  {intl.formatMessage(messages.pasteLabel)}
                </label>
                <input
                  id="chatgpt-callback"
                  type="text"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  value={pasted}
                  disabled={submitting}
                  placeholder={`${redirectUri}?code=…`}
                  onChange={(e) => {
                    setPasted(e.target.value);
                    setHint(null);
                    accept(e.target.value, false);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      accept(pasted, true);
                    }
                  }}
                />
              </div>
            </div>
          )}
        </div>

        {!error && authorizeUrl ? (
          <button
            type="button"
            className="mt-3 inline-flex items-center gap-1 text-sm text-indigo-300 hover:underline"
            onClick={() => openSignIn(authorizeUrl)}
          >
            {intl.formatMessage(messages.openAgain)}
            <ArrowTopRightOnSquareIcon className="h-4 w-4" />
          </button>
        ) : null}
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
      {error ? (
        <div className="mt-4">
          <Alert type="error" title={error.message} />
        </div>
      ) : null}
      <div className="mt-6">
        {starting ? (
          <SmallLoadingSpinner />
        ) : authorizeUrl ? (
          <Button
            type="button"
            buttonType="primary"
            className="min-h-11"
            onClick={begin}
          >
            <span>{intl.formatMessage(messages.continue)}</span>
            <ArrowTopRightOnSquareIcon className="ml-2 h-4 w-4" />
          </Button>
        ) : null}
      </div>
    </Modal>
  );
});

const StepNumber = ({ n }: { n: number }) => (
  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-semibold text-white">
    {n}
  </span>
);

ChatgptConnectModal.displayName = 'ChatgptConnectModal';

export default ChatgptConnectModal;
