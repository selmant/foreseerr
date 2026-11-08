import { aiErrorOf } from '@app/components/Ai/aiError';
import Alert from '@app/components/Common/Alert';
import Modal from '@app/components/Common/Modal';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { LockClosedIcon } from '@heroicons/react/24/solid';
import type { AiConnection } from '@shared/interfaces/api/aiInterfaces';
import axios from 'axios';
import { Field, Formik } from 'formik';
import { forwardRef, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Ai.EndpointModal', {
  baseUrl: 'Base URL',
  baseUrlTip: 'The address that ends in /v1 on most servers.',
  apiKey: 'API key',
  apiKeyTip: 'Optional for local servers like Ollama.',
  apiKeySaved:
    'A key is saved, encrypted. It is never shown again. Leave this empty to keep it.',
  removeKey: 'Remove the saved key',
  presets: 'Quick fill',
  encryptedNote:
    'Keys are encrypted on this server and never sent back to a browser, not even an admin’s.',
  moveWarning:
    'This is a different address than before (another server, port, or http instead of https). Enter the key again; the saved one is never sent to a new address.',
});

const PRESETS = [
  { label: 'OpenAI', url: 'https://api.openai.com/v1' },
  { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
  { label: 'Ollama', url: 'http://ollama:11434/v1' },
  { label: 'LM Studio', url: 'http://localhost:1234/v1' },
] as const;

// Scheme, host and port: dropping to plain HTTP counts as a move too.
const hostOf = (url: string) => {
  try {
    const parsed = new URL(url.trim());
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return '';
  }
};

type EndpointModalProps = {
  title: string;
  description: string;
  /** The `PUT` route that saves the endpoint. */
  endpoint: string;
  existing: AiConnection | null;
  onClose: () => void;
  onSaved: (data: unknown) => void;
};

const EndpointModal = forwardRef<HTMLDivElement, EndpointModalProps>(
  ({ title, description, endpoint, existing, onClose, onSaved }, ref) => {
    const intl = useIntl();
    const [error, setError] = useState<string | null>(null);
    const current = existing?.kind === 'openai' ? existing : null;
    const savedKey = Boolean(current?.hasApiKey);

    return (
      <Formik
        initialValues={{
          baseUrl: current?.baseUrl ?? '',
          apiKey: '',
          clearApiKey: false,
        }}
        onSubmit={async (values) => {
          setError(null);
          try {
            const res = await axios.put(endpoint, {
              baseUrl: values.baseUrl.trim(),
              ...(values.apiKey.trim() ? { apiKey: values.apiKey.trim() } : {}),
              ...(values.clearApiKey ? { clearApiKey: true } : {}),
            });
            onSaved(res.data);
          } catch (e) {
            setError(
              aiErrorOf(e, intl.formatMessage(globalMessages.error)).message
            );
          }
        }}
      >
        {({ handleSubmit, isSubmitting, values, setFieldValue }) => {
          const moved =
            savedKey &&
            !values.clearApiKey &&
            values.apiKey.trim() === '' &&
            hostOf(values.baseUrl) !== '' &&
            hostOf(values.baseUrl) !== hostOf(current?.baseUrl ?? '');
          return (
            <Modal
              ref={ref}
              title={title}
              backgroundClickable={false}
              onCancel={onClose}
              okText={intl.formatMessage(
                isSubmitting ? globalMessages.saving : globalMessages.save
              )}
              okDisabled={isSubmitting || values.baseUrl.trim() === ''}
              onOk={() => handleSubmit()}
            >
              <form onSubmit={handleSubmit}>
                <p className="description">{description}</p>
                {error ? (
                  <div className="mt-4">
                    <Alert type="error" title={error} />
                  </div>
                ) : null}
                <div className="form-row">
                  <label htmlFor="baseUrl" className="text-label">
                    {intl.formatMessage(messages.baseUrl)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.baseUrlTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        id="baseUrl"
                        name="baseUrl"
                        type="text"
                        inputMode="url"
                        autoComplete="off"
                        spellCheck={false}
                        placeholder="https://api.openai.com/v1"
                      />
                    </div>
                    <div
                      className="mt-2 flex flex-wrap gap-2"
                      role="group"
                      aria-label={intl.formatMessage(messages.presets)}
                    >
                      {PRESETS.map((p) => (
                        <button
                          key={p.label}
                          type="button"
                          className={`min-h-9 rounded-full border px-3 py-1 text-xs font-medium transition ${
                            values.baseUrl === p.url
                              ? 'border-indigo-400 bg-indigo-500/20 text-indigo-100'
                              : 'border-gray-600 text-gray-300 hover:border-gray-400 hover:text-white'
                          }`}
                          onClick={() => setFieldValue('baseUrl', p.url)}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="apiKey" className="text-label">
                    {intl.formatMessage(messages.apiKey)}
                    <span className="label-tip">
                      {intl.formatMessage(
                        savedKey ? messages.apiKeySaved : messages.apiKeyTip
                      )}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <SensitiveInput
                        as="field"
                        id="apiKey"
                        name="apiKey"
                        autoComplete="off"
                        disabled={values.clearApiKey}
                        placeholder={savedKey ? '••••••••••••' : ''}
                      />
                    </div>
                    {moved ? (
                      <p className="warning">
                        {intl.formatMessage(messages.moveWarning)}
                      </p>
                    ) : null}
                    {savedKey ? (
                      <label className="mt-3 flex items-center gap-2 font-medium text-gray-300">
                        <Field type="checkbox" name="clearApiKey" />
                        <span>{intl.formatMessage(messages.removeKey)}</span>
                      </label>
                    ) : null}
                  </div>
                </div>
                <p className="mt-6 flex items-start gap-2 text-sm text-gray-400">
                  <LockClosedIcon className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
                  <span>{intl.formatMessage(messages.encryptedNote)}</span>
                </p>
              </form>
            </Modal>
          );
        }}
      </Formik>
    );
  }
);

EndpointModal.displayName = 'EndpointModal';

export default EndpointModal;
