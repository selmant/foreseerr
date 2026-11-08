import { aiErrorOf } from '@app/components/Ai/aiError';
import { fetchModels } from '@app/components/Ai/fetchModels';
import EndpointModal from '@app/components/Ai/EndpointModal';
import ModelPicker from '@app/components/Ai/ModelPicker';
import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import SettingsBadge from '@app/components/Settings/SettingsBadge';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import {
  BeakerIcon,
  CheckCircleIcon,
  LockClosedIcon,
  PencilIcon,
  PlusIcon,
  ServerIcon,
  TrashIcon,
} from '@heroicons/react/24/outline';
import type {
  AiModel,
  AiSettings,
  AiTestResult,
} from '@shared/interfaces/api/aiInterfaces';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import { Fragment, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate as globalMutate } from 'swr';

const messages = defineMessages('components.Settings.SettingsAi', {
  ai: 'AI',
  aiDescription:
    'Suggestions from a mood, a title someone loves, or (only if they allow it) their watch history. Foreseerr finds real titles first; the model plans the search and ranks what was found.',
  loadFailed: 'Unable to load AI settings.',
  enabled: 'Turn on AI features',
  enabledTip: 'Until this is on, nobody sees AI features.',
  nobodyCanUse:
    'Nobody can use AI yet. Add a server connection, or let people connect their own ChatGPT account.',
  serverConnection: 'Server connection',
  serverConnectionDescription:
    'The connection everyone uses unless they connect their own. Any OpenAI-compatible endpoint works: OpenAI with an API key, OpenRouter, Ollama, LM Studio.',
  noServerConnection: 'No server connection yet',
  noServerConnectionHint:
    'Without one, only people who connect their own account can use AI.',
  addEndpoint: 'Add endpoint',
  editEndpoint: 'Edit endpoint',
  endpointModalTitle: 'Server connection',
  endpointModalDescription:
    'Everyone who uses the server connection sends requests here, on your quota.',
  remove: 'Remove',
  removeConfirm: 'Remove?',
  keySaved: 'Key saved, encrypted',
  noKey: 'No API key',
  lastUsed: 'Last used {date}',
  neverUsed: 'Not used yet',
  lastError: 'Last error: {error}',
  testOk: 'Connected. {count, plural, one {# model} other {# models}} listed.',
  testReply: 'Connected. {model} replied “{reply}”.',
  chatgptNote:
    'Why not a ChatGPT subscription here? OpenAI’s terms don’t allow one ChatGPT account to be used by other people. So ChatGPT plans connect per person, in each user’s Linked Accounts, and only serve that person.',
  models: 'Models',
  modelsDescription:
    'Everyone starts on Balanced. When you allow it, people can switch to Fast or Best on their AI page.',
  balanced: 'Balanced',
  balancedTip: 'The default for everyone.',
  fast: 'Fast',
  fastTip: 'Quicker and cheaper; fine for short prompts.',
  best: 'Best',
  bestTip: 'The strongest model you want to offer.',
  sameAsBalanced: 'Same as Balanced',
  pickBalanced: 'Pick a Balanced model, or nothing can run.',
  access: 'Who can use what',
  shareServerConnection: 'Everyone can use the server connection',
  shareServerConnectionTip:
    'When off, only admins can. Everyone else needs their own account.',
  allowUserChatgpt: 'People can connect their own ChatGPT account',
  allowUserChatgptTip:
    'Their requests use their own plan’s limits. Only they can use it.',
  allowUserEndpoints: 'People can add their own endpoint',
  allowUserEndpointsTip:
    'This lets anyone make this server call an address they choose. Leave it off unless you trust every user.',
  allowUserModelChoice: 'People can choose Fast, Balanced or Best',
  allowUserModelChoiceTip:
    'On the server connection. People with their own account always pick their model.',
  dailyLimit: 'Daily AI requests per person',
  dailyLimitTip:
    'On the server connection, counted per person and reset at midnight UTC. Each AI Picks request and each AI Discover row refresh counts as one. Admins and people using their own account aren’t limited. 0 means no limit.',
  webSearch: 'Web search',
  webSearchDescription:
    'With a SearXNG instance, Foreseerr can look up titles too new or too niche for the catalogs. Searches run from this server; no search provider account is needed.',
  searxngEnabled: 'Use SearXNG for web search',
  searxngUrl: 'SearXNG URL',
  searxngUrlTip:
    'Its JSON output must be on (search.formats: json) and its limiter off.',
  searxngOk:
    'SearXNG answered with {count, plural, one {# result} other {# results}}.',
  searxngDocs: 'Setup guide',
  protection: 'How keys are protected',
  protectionDescription:
    'API keys and ChatGPT sign-ins are encrypted at rest (AES-256-GCM) with this server’s secret key. Foreseerr never sends them back to a browser: not to you, not to other admins. Someone with access to the server itself and its key could still decrypt them.',
  keyFromEnv: 'Secret key: FORESEERR_SECRET_KEY environment variable.',
  keyFromFile: 'Secret key: the file in FORESEERR_SECRET_KEY_FILE.',
  keyFromConfig: 'Secret key: secret.key in the config folder.',
  keyBesideDatabase:
    'The secret key sits next to the database, so a copy of the config folder holds both. Set FORESEERR_SECRET_KEY_FILE (for example, to a Docker or Kubernetes secret) to keep them apart.',
  toastSaved: 'AI settings saved.',
  toastSaveFailed: 'AI settings could not be saved.',
  toastConnectionSaved: 'Server connection saved.',
  toastConnectionRemoved: 'Server connection removed.',
});

const Section = ({
  title,
  description,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  children: React.ReactNode;
}) => (
  <section className="mb-8 rounded-xl border border-gray-700 bg-gray-800/40 p-4 sm:p-6">
    <h3 className="text-lg font-semibold text-gray-100">{title}</h3>
    {description ? <p className="description">{description}</p> : null}
    {children}
  </section>
);

type Values = {
  enabled: boolean;
  shareServerConnection: boolean;
  allowUserChatgpt: boolean;
  allowUserEndpoints: boolean;
  allowUserModelChoice: boolean;
  dailyLimit: string;
  balanced: string;
  fast: string;
  best: string;
  searxngEnabled: boolean;
  searxngUrl: string;
};

const SettingsAi = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<AiSettings>('/api/v1/settings/ai');
  const connection = data?.connection ?? null;
  const {
    data: models,
    error: modelsError,
    isLoading: modelsLoading,
  } = useSWR<AiModel[]>(
    connection
      ? ['/api/v1/settings/ai/connection/models', connection.updatedAt]
      : null,
    fetchModels,
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const [endpointOpen, setEndpointOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<
    { ok: true; text: string } | { ok: false; text: string } | null
  >(null);
  const [searchTesting, setSearchTesting] = useState(false);
  const [searchResult, setSearchResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  const listError = modelsError
    ? aiErrorOf(modelsError, intl.formatMessage(globalMessages.error)).message
    : undefined;

  const refresh = (next?: AiSettings) => {
    if (next) {
      mutate(next, { revalidate: false });
    } else {
      mutate();
    }
    globalMutate('/api/v1/settings/public');
  };

  const removeConnection = async () => {
    try {
      const res = await axios.delete<AiSettings>(
        '/api/v1/settings/ai/connection'
      );
      refresh(res.data);
      setTestResult(null);
      addToast(intl.formatMessage(messages.toastConnectionRemoved), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch (e) {
      addToast(aiErrorOf(e, intl.formatMessage(globalMessages.error)).message, {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const testConnection = async (model: string) => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await axios.post<AiTestResult>(
        '/api/v1/settings/ai/connection/test',
        model ? { model } : {}
      );
      setTestResult({
        ok: true,
        text:
          res.data.model && res.data.reply
            ? intl.formatMessage(messages.testReply, {
                model: res.data.model,
                reply: res.data.reply,
              })
            : intl.formatMessage(messages.testOk, { count: res.data.models }),
      });
    } catch (e) {
      setTestResult({
        ok: false,
        text: aiErrorOf(e, intl.formatMessage(globalMessages.error)).message,
      });
    } finally {
      setTesting(false);
      mutate();
    }
  };

  const testSearch = async (url: string) => {
    setSearchTesting(true);
    setSearchResult(null);
    try {
      const res = await axios.post<{ ok: boolean; results: number }>(
        '/api/v1/settings/ai/searxng/test',
        url.trim() ? { url: url.trim() } : {}
      );
      setSearchResult({
        ok: true,
        text: intl.formatMessage(messages.searxngOk, {
          count: res.data.results,
        }),
      });
    } catch (e) {
      setSearchResult({
        ok: false,
        text: aiErrorOf(e, intl.formatMessage(globalMessages.error)).message,
      });
    } finally {
      setSearchTesting(false);
    }
  };

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return (
      <Alert type="error" title={intl.formatMessage(messages.loadFailed)} />
    );
  }

  const keySourceText = intl.formatMessage(
    data.secretKey.source === 'env'
      ? messages.keyFromEnv
      : data.secretKey.source === 'file'
        ? messages.keyFromFile
        : messages.keyFromConfig
  );

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.ai),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.ai)}</h3>
        <p className="description">
          {intl.formatMessage(messages.aiDescription)}
        </p>
      </div>
      <Formik<Values>
        enableReinitialize
        initialValues={{
          enabled: data.enabled,
          shareServerConnection: data.shareServerConnection,
          allowUserChatgpt: data.allowUserChatgpt,
          allowUserEndpoints: data.allowUserEndpoints,
          allowUserModelChoice: data.allowUserModelChoice,
          dailyLimit: String(data.dailyLimit),
          balanced: connection?.model ?? '',
          fast: data.models.fast ?? '',
          best: data.models.best ?? '',
          searxngEnabled: data.searxng.enabled,
          searxngUrl: data.searxng.url,
        }}
        onSubmit={async (values) => {
          try {
            if (connection && values.balanced !== (connection.model ?? '')) {
              await axios.post('/api/v1/settings/ai/connection/model', {
                model: values.balanced.trim() || null,
              });
            }
            const res = await axios.post<AiSettings>('/api/v1/settings/ai', {
              enabled: values.enabled,
              shareServerConnection: values.shareServerConnection,
              allowUserChatgpt: values.allowUserChatgpt,
              allowUserEndpoints: values.allowUserEndpoints,
              allowUserModelChoice: values.allowUserModelChoice,
              dailyLimit: Math.min(
                1000,
                Math.max(0, Math.round(Number(values.dailyLimit) || 0))
              ),
              models: {
                fast: values.fast.trim() || null,
                best: values.best.trim() || null,
              },
              searxng: {
                enabled: values.searxngEnabled,
                url: values.searxngUrl.trim(),
              },
            });
            refresh(res.data);
            addToast(intl.formatMessage(messages.toastSaved), {
              appearance: 'success',
              autoDismiss: true,
            });
          } catch (e) {
            addToast(
              aiErrorOf(e, intl.formatMessage(messages.toastSaveFailed))
                .message,
              { appearance: 'error', autoDismiss: true }
            );
            mutate();
          }
        }}
      >
        {({ values, setFieldValue, isSubmitting, dirty }) => (
          <Form data-testid="settings-ai-form">
            <Section title={intl.formatMessage(messages.ai)}>
              <div className="form-row">
                <label htmlFor="enabled" className="checkbox-label">
                  <span>{intl.formatMessage(messages.enabled)}</span>
                  <span className="label-tip">
                    {intl.formatMessage(messages.enabledTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  <Field type="checkbox" id="enabled" name="enabled" />
                </div>
              </div>
              {values.enabled && !connection && !values.allowUserChatgpt ? (
                <div className="mt-4">
                  <Alert
                    type="warning"
                    title={intl.formatMessage(messages.nobodyCanUse)}
                  />
                </div>
              ) : null}
            </Section>

            <Section
              title={intl.formatMessage(messages.serverConnection)}
              description={intl.formatMessage(
                messages.serverConnectionDescription
              )}
            >
              {connection ? (
                <div className="mt-5 rounded-lg bg-gray-900/50 p-4 ring-1 ring-gray-700">
                  <div className="flex flex-wrap items-start gap-4">
                    <ServerIcon className="h-10 w-10 shrink-0 text-indigo-300" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-lg font-semibold text-white">
                          {connection.providerLabel}
                        </span>
                        <Badge
                          badgeType={connection.hasApiKey ? 'success' : 'dark'}
                        >
                          {intl.formatMessage(
                            connection.hasApiKey
                              ? messages.keySaved
                              : messages.noKey
                          )}
                        </Badge>
                      </div>
                      <div className="mt-1 break-all font-mono text-sm text-gray-400">
                        {connection.baseUrl}
                      </div>
                      <div className="mt-1 text-sm text-gray-500">
                        {connection.lastUsedAt
                          ? intl.formatMessage(messages.lastUsed, {
                              date: intl.formatDate(connection.lastUsedAt, {
                                dateStyle: 'medium',
                                timeStyle: 'short',
                              }),
                            })
                          : intl.formatMessage(messages.neverUsed)}
                      </div>
                      {connection.lastError ? (
                        <div className="mt-1 text-sm text-red-400">
                          {intl.formatMessage(messages.lastError, {
                            error: connection.lastError,
                          })}
                        </div>
                      ) : null}
                    </div>
                    <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                      <Button
                        type="button"
                        className="min-h-11"
                        disabled={testing}
                        onClick={() => testConnection(values.balanced)}
                      >
                        <BeakerIcon />
                        <span>
                          {intl.formatMessage(
                            testing
                              ? globalMessages.testing
                              : globalMessages.test
                          )}
                        </span>
                      </Button>
                      <Button
                        type="button"
                        className="min-h-11"
                        onClick={() => setEndpointOpen(true)}
                      >
                        <PencilIcon />
                        <span>{intl.formatMessage(messages.editEndpoint)}</span>
                      </Button>
                      <ConfirmButton
                        className="min-h-11"
                        onClick={removeConnection}
                        confirmText={intl.formatMessage(messages.removeConfirm)}
                      >
                        <TrashIcon />
                        <span>{intl.formatMessage(messages.remove)}</span>
                      </ConfirmButton>
                    </div>
                  </div>
                  {testResult ? (
                    <p
                      role="status"
                      className={`mt-3 flex items-start gap-2 text-sm ${
                        testResult.ok ? 'text-green-400' : 'text-red-400'
                      }`}
                    >
                      {testResult.ok ? (
                        <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
                      ) : null}
                      <span>{testResult.text}</span>
                    </p>
                  ) : null}
                </div>
              ) : (
                <div className="mt-5 flex flex-col items-start gap-3 rounded-lg border border-dashed border-gray-600 p-5">
                  <div>
                    <div className="font-semibold text-gray-200">
                      {intl.formatMessage(messages.noServerConnection)}
                    </div>
                    <div className="text-sm text-gray-400">
                      {intl.formatMessage(messages.noServerConnectionHint)}
                    </div>
                  </div>
                  <Button
                    type="button"
                    buttonType="primary"
                    className="min-h-11"
                    onClick={() => setEndpointOpen(true)}
                  >
                    <PlusIcon />
                    <span>{intl.formatMessage(messages.addEndpoint)}</span>
                  </Button>
                </div>
              )}
              <p className="mt-4 max-w-4xl text-sm text-gray-400">
                {intl.formatMessage(messages.chatgptNote)}
              </p>
            </Section>

            {connection ? (
              <Section
                title={intl.formatMessage(messages.models)}
                description={intl.formatMessage(messages.modelsDescription)}
              >
                {(
                  [
                    ['balanced', messages.balanced, messages.balancedTip],
                    ['fast', messages.fast, messages.fastTip],
                    ['best', messages.best, messages.bestTip],
                  ] as const
                ).map(([name, label, tip]) => (
                  <div className="form-row" key={name}>
                    <label htmlFor={`model-${name}`} className="text-label">
                      {intl.formatMessage(label)}
                      <span className="label-tip">
                        {intl.formatMessage(tip)}
                      </span>
                    </label>
                    <div className="form-input-area">
                      <div className="form-input-field">
                        <ModelPicker
                          id={`model-${name}`}
                          value={values[name]}
                          onChange={(v) => setFieldValue(name, v)}
                          models={models}
                          loading={modelsLoading}
                          listError={listError}
                          emptyLabel={
                            name === 'balanced'
                              ? undefined
                              : intl.formatMessage(messages.sameAsBalanced)
                          }
                        />
                      </div>
                      {name === 'balanced' && values.balanced === '' ? (
                        <p className="warning">
                          {intl.formatMessage(messages.pickBalanced)}
                        </p>
                      ) : null}
                    </div>
                  </div>
                ))}
              </Section>
            ) : null}

            <Section title={intl.formatMessage(messages.access)}>
              {(
                [
                  [
                    'shareServerConnection',
                    messages.shareServerConnection,
                    messages.shareServerConnectionTip,
                    false,
                  ],
                  [
                    'allowUserChatgpt',
                    messages.allowUserChatgpt,
                    messages.allowUserChatgptTip,
                    false,
                  ],
                  [
                    'allowUserModelChoice',
                    messages.allowUserModelChoice,
                    messages.allowUserModelChoiceTip,
                    false,
                  ],
                  [
                    'allowUserEndpoints',
                    messages.allowUserEndpoints,
                    messages.allowUserEndpointsTip,
                    true,
                  ],
                ] as const
              ).map(([name, label, tip, advanced]) => (
                <div className="form-row" key={name}>
                  <label htmlFor={name} className="checkbox-label">
                    <span className="mr-2">{intl.formatMessage(label)}</span>
                    {advanced ? <SettingsBadge badgeType="advanced" /> : null}
                    <span className="label-tip">{intl.formatMessage(tip)}</span>
                  </label>
                  <div className="form-input-area">
                    <Field type="checkbox" id={name} name={name} />
                  </div>
                </div>
              ))}
              <div className="form-row">
                <label htmlFor="dailyLimit" className="text-label">
                  <span>{intl.formatMessage(messages.dailyLimit)}</span>
                  <span className="label-tip">
                    {intl.formatMessage(messages.dailyLimitTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={1000}
                      id="dailyLimit"
                      name="dailyLimit"
                      className="short"
                    />
                  </div>
                </div>
              </div>
            </Section>

            <Section
              title={intl.formatMessage(messages.webSearch)}
              description={
                <>
                  {intl.formatMessage(messages.webSearchDescription)}{' '}
                  <a
                    href="https://docs.searxng.org/admin/installation-docker.html"
                    target="_blank"
                    rel="noreferrer"
                    className="text-white underline transition hover:text-gray-200"
                  >
                    {intl.formatMessage(messages.searxngDocs)}
                  </a>
                </>
              }
            >
              <div className="form-row">
                <label htmlFor="searxngEnabled" className="checkbox-label">
                  {intl.formatMessage(messages.searxngEnabled)}
                </label>
                <div className="form-input-area">
                  <Field
                    type="checkbox"
                    id="searxngEnabled"
                    name="searxngEnabled"
                  />
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="searxngUrl" className="text-label">
                  {intl.formatMessage(messages.searxngUrl)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.searxngUrlTip)}
                  </span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      id="searxngUrl"
                      name="searxngUrl"
                      type="text"
                      inputMode="url"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder="http://searxng:8080"
                      className="rounded-l-only"
                    />
                    <button
                      type="button"
                      className="input-action"
                      disabled={
                        searchTesting || values.searxngUrl.trim() === ''
                      }
                      onClick={() => testSearch(values.searxngUrl)}
                    >
                      <BeakerIcon />
                      <span>
                        {intl.formatMessage(
                          searchTesting
                            ? globalMessages.testing
                            : globalMessages.test
                        )}
                      </span>
                    </button>
                  </div>
                  {searchResult ? (
                    <p
                      role="status"
                      className={`mt-2 text-sm ${
                        searchResult.ok ? 'text-green-400' : 'text-red-400'
                      }`}
                    >
                      {searchResult.text}
                    </p>
                  ) : null}
                </div>
              </div>
            </Section>

            <Section title={intl.formatMessage(messages.protection)}>
              <p className="mt-2 flex max-w-4xl items-start gap-2 text-sm text-gray-300">
                <LockClosedIcon className="mt-0.5 h-4 w-4 shrink-0 text-gray-400" />
                <span>
                  {intl.formatMessage(messages.protectionDescription)}
                </span>
              </p>
              <p className="mt-3 text-sm text-gray-400">{keySourceText}</p>
              {data.secretKey.besideDatabase ? (
                <div className="mt-4">
                  <Alert
                    type="warning"
                    title={intl.formatMessage(messages.keyBesideDatabase)}
                  />
                </div>
              ) : null}
            </Section>

            <div className="actions">
              <div className="flex justify-end">
                <span className="ml-3 inline-flex rounded-md shadow-sm">
                  <Button
                    buttonType="primary"
                    type="submit"
                    disabled={isSubmitting || !dirty}
                  >
                    <span>
                      {intl.formatMessage(
                        isSubmitting
                          ? globalMessages.saving
                          : globalMessages.save
                      )}
                    </span>
                  </Button>
                </span>
              </div>
            </div>
          </Form>
        )}
      </Formik>
      <Transition as={Fragment} show={endpointOpen}>
        <EndpointModal
          title={intl.formatMessage(messages.endpointModalTitle)}
          description={intl.formatMessage(messages.endpointModalDescription)}
          endpoint="/api/v1/settings/ai/connection"
          existing={connection}
          onClose={() => setEndpointOpen(false)}
          onSaved={(next) => {
            setEndpointOpen(false);
            setTestResult(null);
            refresh(next as AiSettings);
            addToast(intl.formatMessage(messages.toastConnectionSaved), {
              appearance: 'success',
              autoDismiss: true,
            });
          }}
        />
      </Transition>
    </>
  );
};

export default SettingsAi;
