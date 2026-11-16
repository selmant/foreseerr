import { aiErrorOf } from '@app/components/Ai/aiError';
import { fetchModels } from '@app/components/Ai/fetchModels';
import EndpointModal from '@app/components/Ai/EndpointModal';
import ModelPicker from '@app/components/Ai/ModelPicker';
import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import LinkButton from '@app/components/Common/LinkButton';
import type { SegmentedOption } from '@app/components/Common/SegmentedControl';
import SegmentedControl from '@app/components/Common/SegmentedControl';
import ChatgptConnectModal from '@app/components/UserProfile/UserSettings/UserLinkedAccountsSettings/ChatgptConnectModal';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import {
  ArrowTopRightOnSquareIcon,
  BeakerIcon,
  CheckCircleIcon,
  CommandLineIcon,
  ServerIcon,
  SparklesIcon,
  TrashIcon,
  UserCircleIcon,
  ChevronDownIcon,
} from '@heroicons/react/24/outline';
import type {
  AiConnection,
  AiMe,
  AiModel,
  AiPreset,
  AiTestResult,
} from '@shared/interfaces/api/aiInterfaces';
import axios from 'axios';
import { Fragment, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.UserProfile.UserSettings.UserLinkedAccountsSettings.AiAccount',
  {
    ai: 'AI account',
    manage: 'Manage',
    close: 'Done',
    preferences: 'Taste and history preferences',
    notConnected:
      'Use the server connection or link your own account for AI recommendations.',
    loadFailed: 'Unable to load your AI settings.',
    disabled: 'AI features are turned off on this server.',
    serverTitle: 'The server connection',
    ownEndpointWho: 'Counts against your endpoint’s quota.',
    unavailableOwnSignIn:
      'Sign in to your AI account again, or use the server connection.',
    manageUsage: 'Manage usage',
    inUse: 'In use',
    useThis: 'Use this',
    switching: 'Switching…',
    serverCardHint: 'Shared by everyone on this server. {provider}.',
    serverUnavailable:
      'Not available to you: your admin hasn’t set one up, or keeps it for admins.',
    presetLabel: 'Speed and quality',
    presetHint:
      'Fast answers quickest. Best takes longer and may cost the server more.',
    fast: 'Fast',
    balanced: 'Balanced',
    best: 'Best',
    ownCard: 'Your own account',
    ownNotAllowed: 'Your admin hasn’t allowed personal accounts.',
    chatgptOption: 'ChatGPT',
    chatgptOptionHint:
      'Sign in with your ChatGPT plan. Requests use your plan’s limits.',
    continueChatgpt: 'Continue with ChatGPT',
    endpointOption: 'OpenAI-compatible endpoint',
    endpointOptionHint:
      'An API key for OpenAI or OpenRouter, or a local server like Ollama.',
    addEndpoint: 'Add endpoint',
    editEndpoint: 'Edit',
    endpointModalTitle: 'Your endpoint',
    endpointModalDescription:
      'Only your requests use this endpoint, on its quota.',
    statusOk: 'Connected',
    statusReauth: 'Sign in again',
    statusPlanDisabled: 'Plan use unavailable',
    statusSignedOut: 'Signed out',
    signInAgain: 'Sign in again',
    signOut: 'Sign out',
    signOutConfirm: 'Sign out?',
    remove: 'Remove',
    removeConfirm: 'Remove?',
    model: 'Model',
    saveModel: 'Save model',
    lastError: 'Last error: {error}',
    testOk:
      'Connected. {count, plural, one {# model} other {# models}} available.',
    testReply: 'Connected. {model} replied “{reply}”.',
    toastSignedOut: 'Signed out of ChatGPT. Access was revoked at OpenAI.',
    toastSignedOutUnconfirmed:
      'Signed out here, but OpenAI didn’t confirm the revocation. You can also remove Foreseerr in ChatGPT settings.',
    toastRemoved: 'Your own connection was removed.',
    toastSaved: 'Saved.',
    usageToday:
      '{used} of {limit} AI requests used today on the server connection. They reset at midnight UTC.',
    toastEndpointSaved: 'Your endpoint was saved. Pick its model below.',
  }
);

const Card = ({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}) => (
  <section
    className={`rounded-xl border p-4 transition sm:p-6 ${
      active
        ? 'border-indigo-500/70 bg-indigo-500/5 ring-1 ring-indigo-500/40'
        : 'border-gray-700 bg-gray-800/40'
    }`}
  >
    {children}
  </section>
);

const AiAccount = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<AiMe>('/api/v1/ai/me');
  const [expanded, setExpanded] = useState(false);
  const own = data?.own ?? null;
  const ownAllowedByPolicy = Boolean(
    data?.enabled &&
    (own?.kind === 'chatgpt'
      ? data.policy.allowChatgpt
      : data?.policy.allowEndpoints)
  );
  const ownUsable = own?.status === 'ok' && ownAllowedByPolicy;
  const {
    data: ownModels,
    error: ownModelsError,
    isLoading: ownModelsLoading,
  } = useSWR<AiModel[]>(
    expanded && own && ownUsable
      ? ['/api/v1/ai/me/connection/models', own.updatedAt]
      : null,
    fetchModels,
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const [connectOpen, setConnectOpen] = useState(false);
  const [endpointOpen, setEndpointOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  useEffect(() => {
    setModel(own?.model ?? '');
  }, [own?.model]);

  const fail = (e: unknown) =>
    addToast(aiErrorOf(e, intl.formatMessage(globalMessages.error)).message, {
      appearance: 'error',
      autoDismiss: true,
    });

  const savePrefs = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      const res = await axios.post<AiMe>('/api/v1/ai/me', body);
      mutate(res.data, { revalidate: false });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const saveModel = async () => {
    setBusy(true);
    try {
      const res = await axios.post<AiMe>('/api/v1/ai/me/connection/model', {
        model: model.trim() || null,
      });
      mutate(res.data, { revalidate: false });
      addToast(intl.formatMessage(messages.toastSaved), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setTestResult(null);
    try {
      const res = await axios.delete<AiMe>('/api/v1/ai/me/connection');
      mutate(res.data, { revalidate: false });
      addToast(
        intl.formatMessage(
          res.data.revoked === true
            ? messages.toastSignedOut
            : res.data.revoked === false
              ? messages.toastSignedOutUnconfirmed
              : messages.toastRemoved
        ),
        {
          appearance: res.data.revoked === false ? 'warning' : 'success',
          autoDismiss: true,
        }
      );
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await axios.post<AiTestResult>(
        '/api/v1/ai/me/connection/test',
        model.trim() ? { model: model.trim() } : {}
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
      const body = aiErrorOf(e, intl.formatMessage(globalMessages.error));
      setTestResult({ ok: false, text: body.message });
    } finally {
      setTesting(false);
      mutate();
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

  if (!data.enabled && !own) return null;

  const usingOwn = data.preferences.useOwnConnection;
  const effective = data.effective;
  const presetName = (p: AiPreset) =>
    intl.formatMessage(
      p === 'fast'
        ? messages.fast
        : p === 'best'
          ? messages.best
          : messages.balanced
    );

  const statusBadge = (conn: AiConnection) => {
    switch (conn.status) {
      case 'ok':
        return (
          <Badge badgeType="success">
            {intl.formatMessage(messages.statusOk)}
          </Badge>
        );
      case 'reauth':
        return (
          <Badge badgeType="warning">
            {intl.formatMessage(messages.statusReauth)}
          </Badge>
        );
      case 'plan_disabled':
        return (
          <Badge badgeType="warning">
            {intl.formatMessage(messages.statusPlanDisabled)}
          </Badge>
        );
      default:
        return (
          <Badge badgeType="dark">
            {intl.formatMessage(messages.statusSignedOut)}
          </Badge>
        );
    }
  };

  const presetOptions: SegmentedOption<AiPreset>[] = (
    ['fast', 'balanced', 'best'] as const
  ).map((p) => ({
    value: p,
    label: (
      <span className="flex flex-col items-center leading-tight">
        <span>{presetName(p)}</span>
        {data.server?.presets[p] ? (
          <span className="mt-0.5 text-xs font-normal text-gray-400">
            {data.server.presets[p]}
          </span>
        ) : null}
      </span>
    ),
  }));

  const ownAllowed =
    data.enabled && (data.policy.allowChatgpt || data.policy.allowEndpoints);
  const ownModelChanged = (own?.model ?? '') !== model;

  const accountName = effective.available
    ? effective.source === 'server'
      ? data.server?.providerLabel
      : own?.kind === 'chatgpt'
        ? 'ChatGPT'
        : own?.providerLabel
    : own?.kind === 'chatgpt'
      ? 'ChatGPT'
      : own?.providerLabel;

  return (
    <>
      <section
        id="ai-account"
        className="mt-6 scroll-mt-24 rounded-xl border border-gray-700 bg-gray-800/40 p-4 sm:p-6"
      >
        <div className="flex flex-wrap items-center gap-4">
          <SparklesIcon className="h-10 w-10 shrink-0 text-indigo-300" />
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-semibold">
              {intl.formatMessage(messages.ai)}
            </h3>
            <p
              className="break-words text-sm text-gray-400"
              data-testid="ai-effective"
            >
              {!data.enabled
                ? intl.formatMessage(messages.disabled)
                : effective.available
                  ? [
                      effective.source === 'server'
                        ? intl.formatMessage(messages.serverTitle)
                        : null,
                      accountName,
                      effective.model,
                      effective.source === 'own' ? own?.accountEmail : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : intl.formatMessage(
                      effective.reason === 'own_needs_sign_in'
                        ? messages.unavailableOwnSignIn
                        : messages.notConnected
                    )}
            </p>
            {own ? (
              <div className="mt-1 flex flex-wrap items-center gap-2">
                {!usingOwn ? (
                  <span className="text-sm text-gray-400">
                    {own.kind === 'chatgpt' ? 'ChatGPT' : own.providerLabel} ·{' '}
                    {own.accountEmail ?? own.baseUrl}
                  </span>
                ) : null}
                {statusBadge(own)}
              </div>
            ) : null}
          </div>
          <Button
            aria-expanded={expanded}
            aria-controls="ai-account-details"
            className="min-h-11"
            onClick={() => setExpanded(!expanded)}
          >
            {intl.formatMessage(expanded ? messages.close : messages.manage)}
            <ChevronDownIcon
              className={`h-4 w-4 transition ${expanded ? 'rotate-180' : ''}`}
            />
          </Button>
        </div>
        {expanded ? (
          <div id="ai-account-details" className="mt-5 space-y-4">
            {data.enabled && data.server ? (
              <Card active={!usingOwn && Boolean(data.server)}>
                <div className="flex flex-wrap items-start gap-4">
                  <ServerIcon className="h-8 w-8 shrink-0 text-gray-300" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-lg font-semibold text-white">
                        {intl.formatMessage(messages.serverTitle)}
                      </h4>
                      {!usingOwn && data.server ? (
                        <Badge badgeType="primary">
                          {intl.formatMessage(messages.inUse)}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-sm text-gray-400">
                      {data.server
                        ? intl.formatMessage(messages.serverCardHint, {
                            provider: data.server.providerLabel,
                          })
                        : intl.formatMessage(messages.serverUnavailable)}
                    </p>
                  </div>
                  {usingOwn && data.server ? (
                    <Button
                      className="min-h-11"
                      disabled={busy}
                      onClick={() => savePrefs({ useOwnConnection: false })}
                    >
                      {intl.formatMessage(
                        busy ? messages.switching : messages.useThis
                      )}
                    </Button>
                  ) : null}
                </div>
                {data.server && !usingOwn && data.policy.allowModelChoice ? (
                  <div className="mt-5">
                    <div className="group-label">
                      {intl.formatMessage(messages.presetLabel)}
                    </div>
                    <SegmentedControl
                      ariaLabel={intl.formatMessage(messages.presetLabel)}
                      options={presetOptions}
                      value={data.preferences.model ?? 'balanced'}
                      disabled={busy}
                      wrapLabels
                      className="max-w-xl"
                      onChange={(p) => savePrefs({ model: p })}
                    />
                    <p className="mt-2 text-sm text-gray-400">
                      {intl.formatMessage(messages.presetHint)}
                    </p>
                  </div>
                ) : null}
              </Card>
            ) : null}

            {own || ownAllowed ? (
              <Card active={usingOwn && ownUsable}>
                <div className="flex flex-wrap items-start gap-4">
                  <UserCircleIcon className="h-8 w-8 shrink-0 text-gray-300" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-lg font-semibold text-white">
                        {intl.formatMessage(messages.ownCard)}
                      </h4>
                      {usingOwn && own ? (
                        <Badge badgeType="primary">
                          {intl.formatMessage(messages.inUse)}
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-sm text-gray-400">
                      {intl.formatMessage(
                        ownAllowed || own
                          ? own?.kind === 'openai'
                            ? messages.ownEndpointWho
                            : messages.chatgptOptionHint
                          : messages.ownNotAllowed
                      )}
                    </p>
                  </div>
                  {own && !usingOwn && ownUsable ? (
                    <Button
                      className="min-h-11"
                      disabled={busy}
                      onClick={() => savePrefs({ useOwnConnection: true })}
                    >
                      {intl.formatMessage(
                        busy ? messages.switching : messages.useThis
                      )}
                    </Button>
                  ) : null}
                </div>

                {own ? (
                  <div className="mt-5 rounded-lg bg-gray-900/50 p-4 ring-1 ring-gray-700">
                    <div className="flex flex-wrap items-center gap-3">
                      {own.kind === 'chatgpt' ? (
                        <SparklesIcon className="h-6 w-6 text-gray-300" />
                      ) : (
                        <CommandLineIcon className="h-6 w-6 text-gray-300" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold text-white">
                            {own.kind === 'chatgpt'
                              ? intl.formatMessage(messages.chatgptOption)
                              : own.providerLabel}
                          </span>
                          {statusBadge(own)}
                        </div>
                        <div className="break-all text-sm text-gray-400">
                          {own.kind === 'chatgpt'
                            ? (own.accountEmail ?? own.accountName)
                            : own.baseUrl}
                        </div>
                      </div>
                      <div className="flex w-full flex-wrap gap-2 sm:w-auto">
                        {own.kind === 'chatgpt' &&
                        !ownUsable &&
                        ownAllowedByPolicy ? (
                          <Button
                            buttonType="primary"
                            className="min-h-11"
                            onClick={() => setConnectOpen(true)}
                          >
                            {intl.formatMessage(messages.signInAgain)}
                          </Button>
                        ) : null}
                        {ownUsable ? (
                          <Button
                            className="min-h-11"
                            disabled={testing}
                            onClick={test}
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
                        ) : null}
                        {own.kind === 'openai' && ownAllowedByPolicy ? (
                          <Button
                            className="min-h-11"
                            onClick={() => setEndpointOpen(true)}
                          >
                            {intl.formatMessage(messages.editEndpoint)}
                          </Button>
                        ) : null}
                        <ConfirmButton
                          className="min-h-11"
                          disabled={busy}
                          onClick={disconnect}
                          confirmText={intl.formatMessage(
                            own.kind === 'chatgpt' &&
                              own.status !== 'signed_out'
                              ? messages.signOutConfirm
                              : messages.removeConfirm
                          )}
                        >
                          <TrashIcon />
                          <span>
                            {intl.formatMessage(
                              own.kind === 'chatgpt' &&
                                own.status !== 'signed_out'
                                ? messages.signOut
                                : messages.remove
                            )}
                          </span>
                        </ConfirmButton>
                      </div>
                    </div>
                    {own.lastError && own.status !== 'signed_out' ? (
                      <p className="mt-3 text-sm text-red-400">
                        {intl.formatMessage(messages.lastError, {
                          error: own.lastError,
                        })}
                      </p>
                    ) : null}
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
                    {ownUsable ? (
                      <div className="mt-4">
                        <label htmlFor="own-model">
                          {intl.formatMessage(messages.model)}
                        </label>
                        <div className="flex max-w-xl flex-wrap items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <ModelPicker
                              id="own-model"
                              value={model}
                              onChange={setModel}
                              models={ownModels}
                              loading={ownModelsLoading}
                              listError={
                                ownModelsError
                                  ? aiErrorOf(
                                      ownModelsError,
                                      intl.formatMessage(globalMessages.error)
                                    ).message
                                  : undefined
                              }
                            />
                          </div>
                          {ownModelChanged ? (
                            <Button
                              buttonType="primary"
                              className="min-h-[38px]"
                              disabled={busy || model.trim() === ''}
                              onClick={saveModel}
                            >
                              {intl.formatMessage(messages.saveModel)}
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : ownAllowed ? (
                  <div className="mt-5 grid gap-3 sm:grid-cols-2">
                    {data.policy.allowChatgpt ? (
                      <div className="flex flex-col rounded-lg border border-gray-700 bg-gray-900/40 p-4">
                        <div className="mb-2 flex items-center gap-2">
                          <SparklesIcon className="h-6 w-6 text-gray-300" />
                          <span className="font-semibold text-white">
                            {intl.formatMessage(messages.chatgptOption)}
                          </span>
                        </div>
                        <p className="mb-4 flex-1 text-sm text-gray-400">
                          {intl.formatMessage(messages.chatgptOptionHint)}
                        </p>
                        <Button
                          buttonType="primary"
                          className="min-h-11 self-start"
                          onClick={() => setConnectOpen(true)}
                        >
                          {intl.formatMessage(messages.continueChatgpt)}
                        </Button>
                      </div>
                    ) : null}
                    {data.policy.allowEndpoints ? (
                      <div className="flex flex-col rounded-lg border border-gray-700 bg-gray-900/40 p-4">
                        <div className="mb-2 flex items-center gap-2">
                          <CommandLineIcon className="h-6 w-6 text-gray-300" />
                          <span className="font-semibold text-white">
                            {intl.formatMessage(messages.endpointOption)}
                          </span>
                        </div>
                        <p className="mb-4 flex-1 text-sm text-gray-400">
                          {intl.formatMessage(messages.endpointOptionHint)}
                        </p>
                        <Button
                          className="min-h-11 self-start"
                          onClick={() => setEndpointOpen(true)}
                        >
                          {intl.formatMessage(messages.addEndpoint)}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </Card>
            ) : null}

            {effective.available && effective.manageUsageUrl ? (
              <Button
                as="a"
                href={effective.manageUsageUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {intl.formatMessage(messages.manageUsage)}
                <ArrowTopRightOnSquareIcon className="ml-2 h-4 w-4" />
              </Button>
            ) : null}
            {data.usage.dailyLimit != null ? (
              <p className="text-sm text-gray-400">
                {intl.formatMessage(messages.usageToday, {
                  used: data.usage.usedToday,
                  limit: data.usage.dailyLimit,
                })}
              </p>
            ) : null}
            <LinkButton to="/profile/settings/discover#ai-preferences">
              {intl.formatMessage(messages.preferences)}
            </LinkButton>
          </div>
        ) : null}
      </section>

      <Transition as={Fragment} show={connectOpen}>
        <ChatgptConnectModal
          redirectUri={data.chatgptRedirectUri}
          consent={own?.kind === 'chatgpt' && own.status === 'plan_disabled'}
          onClose={() => setConnectOpen(false)}
          onConnected={(me) => {
            setTestResult(null);
            mutate(me, { revalidate: false });
          }}
        />
      </Transition>
      <Transition as={Fragment} show={endpointOpen}>
        <EndpointModal
          title={intl.formatMessage(messages.endpointModalTitle)}
          description={intl.formatMessage(messages.endpointModalDescription)}
          endpoint="/api/v1/ai/me/connection"
          existing={own}
          onClose={() => setEndpointOpen(false)}
          onSaved={(next) => {
            setEndpointOpen(false);
            setTestResult(null);
            mutate(next as AiMe, { revalidate: false });
            addToast(intl.formatMessage(messages.toastEndpointSaved), {
              appearance: 'success',
              autoDismiss: true,
            });
          }}
        />
      </Transition>
    </>
  );
};

export default AiAccount;
