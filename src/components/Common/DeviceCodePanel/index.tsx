import Button from '@app/components/Common/Button';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  ClipboardDocumentIcon,
} from '@heroicons/react/24/outline';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages(
  'components.UserProfile.UserSettings.DeviceCodePanel',
  {
    codeLabel: 'Authorization code',
    copyCode: 'Copy code',
    copied: 'Copied',
    copyFailed: 'Select the code above and copy it manually.',
    openService: 'Open {service}',
    keepOpen:
      'Keep this dialog open while you authorize. It will update automatically when you return.',
    expires: 'Code expires in {minutes}:{seconds}',
    expired: 'This code has expired.',
    newCode: 'Get a new code',
  }
);

/** Copyable authorization code shared by device/PIN and Quick Connect flows. */
const DeviceCodePanel = ({
  instructions,
  code,
  waitingText,
  verificationUrl,
  serviceName,
  expiresAt,
  onNewCode,
}: {
  instructions: ReactNode;
  code: string;
  waitingText: string;
  verificationUrl?: string;
  serviceName?: string;
  expiresAt?: number;
  onNewCode?: () => void;
}) => {
  const intl = useIntl();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setCopied(false);
    setCopyFailed(false);
  }, [code]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  useEffect(() => {
    if (!expiresAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  const seconds = expiresAt
    ? Math.max(0, Math.ceil((expiresAt - now) / 1000))
    : undefined;
  const expired = seconds === 0;
  const copyCode = async () => {
    if (expired) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopyFailed(true);
    }
  };
  return (
    <div className="flex flex-col items-center space-y-4">
      <p className="text-center text-gray-300">{instructions}</p>
      <div className="w-full rounded-lg bg-gray-700 px-4 py-4">
        <input
          type="text"
          readOnly
          autoComplete="off"
          spellCheck={false}
          value={code}
          aria-label={intl.formatMessage(messages.codeLabel)}
          onFocus={(event) => event.currentTarget.select()}
          className="min-h-11 w-full min-w-0 rounded-md border-0 bg-transparent px-0 text-center font-mono text-2xl font-bold tracking-wider text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 sm:text-4xl"
        />
      </div>
      <div className="flex w-full flex-wrap justify-center gap-2">
        <Button
          type="button"
          className={`min-h-11 ${expired ? 'cursor-default opacity-50' : ''}`}
          aria-disabled={expired}
          onClick={() => void copyCode()}
        >
          {copied ? <CheckIcon /> : <ClipboardDocumentIcon />}
          <span aria-live="polite">
            {intl.formatMessage(copied ? messages.copied : messages.copyCode)}
          </span>
        </Button>
        {verificationUrl && serviceName && (
          <Button
            as="a"
            href={verificationUrl}
            target="_blank"
            rel="noopener noreferrer"
            buttonType="primary"
            className={`min-h-11 ${expired ? 'cursor-default opacity-50' : ''}`}
            aria-disabled={expired}
            onClick={(event) => {
              if (expired) event.preventDefault();
            }}
          >
            <ArrowTopRightOnSquareIcon />
            <span>
              {intl.formatMessage(messages.openService, {
                service: serviceName,
              })}
            </span>
          </Button>
        )}
      </div>
      {copyFailed && (
        <p role="status" className="text-center text-sm text-yellow-200">
          {intl.formatMessage(messages.copyFailed)}
        </p>
      )}
      {seconds !== undefined && (
        <p className="text-sm text-gray-400" aria-live="off">
          {intl.formatMessage(expired ? messages.expired : messages.expires, {
            minutes: Math.floor(seconds / 60),
            seconds: String(seconds % 60).padStart(2, '0'),
          })}
        </p>
      )}
      {expired && onNewCode ? (
        <Button
          type="button"
          className="min-h-11"
          buttonType="primary"
          onClick={onNewCode}
        >
          {intl.formatMessage(messages.newCode)}
        </Button>
      ) : (
        <>
          <p className="text-center text-sm leading-6 text-gray-400">
            {intl.formatMessage(messages.keepOpen)}
          </p>
          <div
            role="status"
            className="flex items-center space-x-2 text-sm text-gray-400"
          >
            <ArrowPathIcon
              aria-hidden
              className="h-4 w-4 animate-spin motion-reduce:animate-none"
            />
            <span>{waitingText}</span>
          </div>
        </>
      )}
    </div>
  );
};

export default DeviceCodePanel;
