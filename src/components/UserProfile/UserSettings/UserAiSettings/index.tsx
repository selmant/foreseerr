import TasteCard from '@app/components/Ai/TasteCard';
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
import type { SegmentedOption } from '@app/components/Common/SegmentedControl';
import SegmentedControl from '@app/components/Common/SegmentedControl';
import ChatgptConnectModal from '@app/components/UserProfile/UserSettings/UserAiSettings/ChatgptConnectModal';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import {
  ArrowTopRightOnSquareIcon,
  BeakerIcon,
  CheckCircleIcon,
  CommandLineIcon,
  LockClosedIcon,
  ServerIcon,
  SparklesIcon,
  TrashIcon,
  UserCircleIcon,
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
  'components.UserProfile.UserSettings.UserAiSettings',
  {
    ai: 'AI',
    aiDescription:
      'Ask for something in a mood, or for more like a title you love. Choose which AI account answers.',
    loadFailed: 'Unable to load your AI settings.',
    disabled: 'AI features are turned off on this server.',
    nowUsing: 'Your requests go to',
    serverTitle: 'The server connection',
    serverWho:
      'Set up by your admin. Usage counts against the server’s quota, not yours.',
    ownChatgptTitle: 'Your ChatGPT account',
    ownChatgptWho: 'Counts toward your ChatGPT plan’s usage limits.',
    ownEndpointTitle: 'Your own endpoint',
    ownEndpointWho: 'Counts against your endpoint’s quota.',
    noModelYet: 'no model picked yet',
    presetModel: '{preset} · {model}',
    unavailableOwnMissing:
      'Your own connection is missing. Connect one below, or switch back to the server connection.',
    unavailableOwnSignIn:
      'Your own connection needs you to sign in again. Do that below, or switch back to the server connection.',
    unavailableNoServer:
      'There is no server connection you can use. Connect your own account below.',
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
    ownCardHint:
      'Bring your own account when you want a stronger or faster model, or to keep usage on your quota.',
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
    history: 'Use my watch history',
    historyHint:
      'When on, a short summary of what you’ve watched, rated and saved (from your media server and the trackers you linked) goes with your requests to the connection above. When off, only what you type is sent.',
    historySince: 'On since {date}.',
    privacy:
      'Your keys and sign-ins are encrypted on this server. Nobody can read them back through Foreseerr, admins included. Signing out of ChatGPT also revokes Foreseerr’s access at OpenAI.',
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

const UserAiSettings = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { user } = useUser();
  const { data, error, mutate } = useSWR<AiMe>('/api/v1/ai/me');
  const own = data?.own ?? null;
  const ownUsable = own?.status === 'ok';
  const {
    data: ownModels,
    error: ownModelsError,
    isLoading: ownModelsLoading,
  } = useSWR<AiModel[]>(
    own && ownUsable
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

  const title = (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.ai),
          intl.formatMessage(globalMessages.usersettings),
          user?.displayName,
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">{intl.formatMessage(messages.ai)}</h3>
        <p className="description">
          {intl.formatMessage(messages.aiDescription)}
        </p>
      </div>
    </>
  );

  if (!data.enabled) {
    return (
      <>
        {title}
        <Alert type="info" title={intl.formatMessage(messages.disabled)} />
      </>
    );
  }

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

  // The summary every AI surface repeats: whose connection, which model,
  // whose quota.
  const summary = (() => {
    if (!effective.available) {
      const reason =
        effective.reason === 'own_needs_sign_in'
          ? messages.unavailableOwnSignIn
          : effective.reason === 'no_server_connection'
            ? messages.unavailableNoServer
            : messages.unavailableOwnMissing;
      return (
        <Alert type="warning" title={intl.formatMessage(messages.nowUsing)}>
          {intl.formatMessage(reason)}
        </Alert>
      );
    }
    const isServer = effective.source === 'server';
    const isChatgpt = effective.kind === 'chatgpt';
    const Icon = isServer
      ? ServerIcon
      : isChatgpt
        ? SparklesIcon
        : CommandLineIcon;
    const heading = intl.formatMessage(
      isServer
        ? messages.serverTitle
        : isChatgpt
          ? messages.ownChatgptTitle
          : messages.ownEndpointTitle
    );
    const modelText =
      effective.model ?? intl.formatMessage(messages.noModelYet);
    const detail = [
      isServer
        ? data.server?.providerLabel
        : (effective.accountEmail ?? own?.providerLabel),
      effective.preset
        ? intl.formatMessage(messages.presetModel, {
            preset: presetName(effective.preset),
            model: modelText,
          })
        : modelText,
    ]
      .filter(Boolean)
      .join(' · ');
    return (
      <div
        className="flex flex-wrap items-center gap-4 rounded-xl bg-gray-800/70 p-4 ring-1 ring-gray-700 sm:p-5"
        data-testid="ai-effective"
      >
        <Icon className="h-10 w-10 shrink-0 text-indigo-300" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold uppercase tracking-wide text-gray-400">
            {intl.formatMessage(messages.nowUsing)}
          </div>
          <div className="text-lg font-semibold text-white">{heading}</div>
          <div className="break-words text-sm text-gray-300">{detail}</div>
          <div className="mt-1 text-sm text-gray-400">
            {intl.formatMessage(
              isServer
                ? messages.serverWho
                : isChatgpt
                  ? messages.ownChatgptWho
                  : messages.ownEndpointWho
            )}
          </div>
          {data.usage.dailyLimit != null ? (
            <div className="mt-1 text-sm text-gray-400">
              {intl.formatMessage(messages.usageToday, {
                used: data.usage.usedToday,
                limit: data.usage.dailyLimit,
              })}
            </div>
          ) : null}
        </div>
        {effective.manageUsageUrl ? (
          <Button
            as="a"
            href={effective.manageUsageUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="min-h-11"
          >
            <span>{intl.formatMessage(messages.manageUsage)}</span>
            <ArrowTopRightOnSquareIcon className="ml-2 h-4 w-4" />
          </Button>
        ) : null}
      </div>
    );
  })();

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

  const ownAllowed = data.policy.allowChatgpt || data.policy.allowEndpoints;
  const ownModelChanged = (own?.model ?? '') !== model;

  return (
    <>
      {title}
      <div className="space-y-6">
        {summary}

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
          {data.server && data.policy.allowModelChoice ? (
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
                    ? messages.ownCardHint
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
                  {own.kind === 'chatgpt' && !ownUsable ? (
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
                          testing ? globalMessages.testing : globalMessages.test
                        )}
                      </span>
                    </Button>
                  ) : null}
                  {own.kind === 'openai' && data.policy.allowEndpoints ? (
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
                      own.kind === 'chatgpt' && own.status !== 'signed_out'
                        ? messages.signOutConfirm
                        : messages.removeConfirm
                    )}
                  >
                    <TrashIcon />
                    <span>
                      {intl.formatMessage(
                        own.kind === 'chatgpt' && own.status !== 'signed_out'
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

        <TasteCard />

        <Card active={false}>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h4 className="text-lg font-semibold text-white">
                <label htmlFor="ai-history" className="mb-0 text-lg text-white">
                  {intl.formatMessage(messages.history)}
                </label>
              </h4>
              <p className="mt-1 max-w-3xl text-sm text-gray-400">
                {intl.formatMessage(messages.historyHint)}
              </p>
              {data.preferences.useHistory &&
              data.preferences.historyConsentAt ? (
                <p className="mt-1 text-sm text-gray-500">
                  {intl.formatMessage(messages.historySince, {
                    date: intl.formatDate(data.preferences.historyConsentAt, {
                      dateStyle: 'medium',
                    }),
                  })}
                </p>
              ) : null}
            </div>
            <input
              id="ai-history"
              type="checkbox"
              className="mt-1 shrink-0"
              checked={data.preferences.useHistory}
              disabled={busy}
              onChange={(e) => savePrefs({ useHistory: e.target.checked })}
            />
          </div>
        </Card>

        <p className="flex max-w-4xl items-start gap-2 text-sm text-gray-400">
          <LockClosedIcon className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
          <span>{intl.formatMessage(messages.privacy)}</span>
        </p>
      </div>

      <Transition as={Fragment} show={connectOpen}>
        <ChatgptConnectModal
          redirectUri={data.chatgptRedirectUri}
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

export default UserAiSettings;
