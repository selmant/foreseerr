import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import PageTitle from '@app/components/Common/PageTitle';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import SettingsBetterTrakt, {
  type BetterTraktReadiness,
} from '@app/components/Settings/SettingsBetterTrakt';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import {
  ArrowDownOnSquareIcon,
  ArrowPathIcon,
  ArrowRightIcon,
  CheckCircleIcon,
} from '@heroicons/react/24/outline';
import axios from 'axios';
import { Field, Formik, type FormikHelpers } from 'formik';
import { Fragment, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate as globalMutate } from 'swr';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.SettingsTrakt', {
  trakt: 'Trakt',
  traktConnection: 'Trakt connection',
  description:
    'Choose the single server-wide method Foreseerr uses for every user’s Trakt activity.',
  connectionMethod: 'Connection method',
  connectionMethodHint: 'This choice applies to every Foreseerr user.',
  activeMethod: 'Active method',
  directProvider: 'Direct Trakt app',
  directProviderDescription:
    'Foreseerr connects to Trakt directly. Each user authorizes this server’s Trakt application.',
  jellyfinProvider: 'Better Trakt via Jellyfin',
  jellyfinProviderDescription:
    'Foreseerr uses each linked Jellyfin user’s Better Trakt connection and permissions.',
  currentMethod: 'Current method',
  configureBelow: 'Configure below',
  checkedAt: 'Checked {time}',
  checkConnection: 'Check connection',
  checkingConnection: 'Checking…',
  connected: 'Reachable',
  actionRequired: 'Action required',
  notConfigured: 'Not configured',
  unknown: 'Status unavailable',
  statusFailure: 'Foreseerr could not check the integration status.',
  settingsFailure: 'Foreseerr could not load the saved Trakt settings.',
  directSetup: 'Direct application setup',
  directSetupDescription:
    'Create a Trakt application, then enter its credentials below. Each Foreseerr user will authorize it separately.',
  createAppTip:
    'Create an API app at <TraktAppLink>trakt.tv/oauth/applications</TraktAppLink>. Set its redirect URI to urn:ietf:wg:oauth:2.0:oob.',
  clientId: 'Client ID',
  clientSecret: 'Client Secret',
  validationClientId: 'You must provide a Client ID',
  validationClientSecret: 'You must provide a Client Secret',
  clientSecretTip:
    'A secret is saved. Leave this blank to keep it, or enter a replacement.',
  showSecret: 'Show Client Secret',
  hideSecret: 'Hide Client Secret',
  saveDirect: 'Save Direct Trakt credentials',
  switchDirect: 'Switch to Direct Trakt',
  behavior: 'Shared behavior',
  behaviorDescription:
    'These controls apply whichever Trakt connection method is active.',
  actionsEnabled: 'Allow Trakt watched and rating actions',
  actionsEnabledTip:
    'This only controls Trakt. Jellyfin watched status still works when the user is linked to Jellyfin.',
  toastSettingsSuccess: 'Trakt settings saved successfully.',
  toastSettingsFailure: 'Unable to save Trakt settings.',
  toastActionsSuccess: 'Trakt action settings updated.',
  toastActionsFailure: 'Unable to update Trakt action settings.',
  toastHealthFailure: 'Unable to check the Trakt connection.',
  directSwitchTitle: 'Switch to Direct Trakt?',
  directSwitchDescription:
    'Foreseerr will stop using Better Trakt. Jellyfin connections remain intact, but each Foreseerr user must authorize this Direct Trakt application.',
  disconnectConfirmTitle: 'Replace Direct Trakt credentials?',
  disconnectConfirmDescription:
    'Replacing these credentials will disconnect {count, plural, one {# linked Trakt account} other {# linked Trakt accounts}}. Those users must authorize the application again.',
  betterSwitchTitle: 'Switch to Better Trakt?',
  betterSwitchDescription:
    'Foreseerr will permanently remove the saved Direct Trakt Client ID, Client Secret, and {count, plural, one {# linked Direct account} other {# linked Direct accounts}}. Users must be ready in Better Trakt.',
  switchBetter: 'Switch to Better Trakt',
});

type TraktProvider = 'direct' | 'jellyfin';

interface TraktSettingsResponse {
  provider: TraktProvider;
  clientId: string;
  clientSecret: string;
  configured: boolean;
  actionsEnabled: boolean;
  linkedAccountCount?: number;
}

interface TraktFormValues {
  clientId: string;
  clientSecret: string;
}

type IntegrationHealth = {
  state: 'not_configured' | 'healthy' | 'degraded';
  detail: string;
  checkedAt: string | null;
};

type IntegrationHealthResponse = {
  trakt: IntegrationHealth & {
    provider: TraktProvider;
    direct: IntegrationHealth;
    jellyfin: IntegrationHealth & { readiness: BetterTraktReadiness };
  };
};

type SettingsTraktProps = {
  onSave?: () => void;
};

const SettingsTrakt = ({ onSave }: SettingsTraktProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const {
    data,
    error,
    mutate: mutateSettings,
  } = useSWR<TraktSettingsResponse>('/api/v1/settings/trakt');
  const {
    data: health,
    error: healthError,
    mutate: mutateHealth,
  } = useSWR<IntegrationHealthResponse>(
    '/api/v1/settings/integrations/status',
    { refreshInterval: 5 * 60 * 1000 }
  );
  const [viewedProvider, setViewedProvider] = useState<TraktProvider | null>(
    null
  );
  const [checking, setChecking] = useState(false);
  const [savingActions, setSavingActions] = useState(false);
  const [activatingBetter, setActivatingBetter] = useState(false);
  const [directConfirmOpen, setDirectConfirmOpen] = useState(false);
  const [betterConfirmOpen, setBetterConfirmOpen] = useState(false);
  const [pendingSubmit, setPendingSubmit] = useState<{
    values: TraktFormValues;
    helpers: FormikHelpers<TraktFormValues>;
  } | null>(null);

  const selectedProvider = viewedProvider ?? data?.provider ?? 'direct';
  const activeHealth = health?.trakt;

  const TraktSettingsSchema = Yup.object().shape({
    clientId: Yup.string()
      .trim()
      .required(intl.formatMessage(messages.validationClientId)),
    clientSecret: Yup.string()
      .trim()
      .test(
        'clientSecret-required',
        intl.formatMessage(messages.validationClientSecret),
        (value) =>
          data?.provider === 'direct' && data.configured ? true : Boolean(value)
      ),
  });

  const errorMessage = (e: unknown, fallback: string) =>
    axios.isAxiosError(e) && typeof e.response?.data?.message === 'string'
      ? e.response.data.message
      : fallback;

  const credentialsChanging = (values: TraktFormValues) => {
    if (!data) return false;
    const secretUnchanged = values.clientSecret.trim() === '';
    return (
      values.clientId.trim() !== (data.clientId ?? '').trim() ||
      (!secretUnchanged && values.clientSecret.trim() !== data.clientSecret)
    );
  };

  const refreshHealth = async () => {
    setChecking(true);
    try {
      const response = await axios.post<IntegrationHealthResponse>(
        '/api/v1/settings/integrations/status/refresh'
      );
      await mutateHealth(response.data, false);
    } catch {
      addToast(intl.formatMessage(messages.toastHealthFailure), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setChecking(false);
    }
  };

  const saveDirect = async (
    values: TraktFormValues,
    helpers: FormikHelpers<TraktFormValues>,
    confirmed = false
  ) => {
    try {
      await axios.post('/api/v1/settings/trakt', {
        provider: 'direct',
        clientId: values.clientId.trim(),
        clientSecret: values.clientSecret.trim(),
        actionsEnabled: data?.actionsEnabled !== false,
        ...(confirmed ? { confirmDisconnectLinkedAccounts: true } : {}),
      });
      addToast(intl.formatMessage(messages.toastSettingsSuccess), {
        autoDismiss: true,
        appearance: 'success',
      });
      await Promise.all([mutateSettings(), mutateHealth()]);
      setViewedProvider(null);
      onSave?.();
    } catch (e) {
      addToast(
        errorMessage(e, intl.formatMessage(messages.toastSettingsFailure)),
        { autoDismiss: true, appearance: 'error' }
      );
    } finally {
      helpers.setSubmitting(false);
    }
  };

  const activateBetter = async () => {
    setActivatingBetter(true);
    try {
      await axios.post('/api/v1/settings/trakt', {
        provider: 'jellyfin',
        actionsEnabled: data?.actionsEnabled !== false,
        confirmProviderSwitch: true,
      });
      addToast(intl.formatMessage(messages.toastSettingsSuccess), {
        autoDismiss: true,
        appearance: 'success',
      });
      await Promise.all([mutateSettings(), mutateHealth()]);
      await globalMutate('/api/v1/settings/public');
      setViewedProvider(null);
      onSave?.();
    } catch (e) {
      addToast(
        errorMessage(e, intl.formatMessage(messages.toastSettingsFailure)),
        { autoDismiss: true, appearance: 'error' }
      );
    } finally {
      setActivatingBetter(false);
      setBetterConfirmOpen(false);
    }
  };

  const updateActions = async (actionsEnabled: boolean) => {
    setSavingActions(true);
    try {
      await axios.post('/api/v1/settings/trakt/actions', { actionsEnabled });
      await mutateSettings(
        data ? { ...data, actionsEnabled } : undefined,
        false
      );
      addToast(intl.formatMessage(messages.toastActionsSuccess), {
        autoDismiss: true,
        appearance: 'success',
      });
    } catch {
      addToast(intl.formatMessage(messages.toastActionsFailure), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setSavingActions(false);
    }
  };

  if (!data && !error) return <LoadingSpinner />;
  if (error || !data) {
    return (
      <Alert
        type="error"
        title={intl.formatMessage(messages.settingsFailure)}
      />
    );
  }

  const healthBadge = activeHealth
    ? activeHealth.state === 'healthy'
      ? { type: 'success' as const, message: messages.connected }
      : activeHealth.state === 'degraded'
        ? { type: 'danger' as const, message: messages.actionRequired }
        : { type: 'warning' as const, message: messages.notConfigured }
    : { type: 'light' as const, message: messages.unknown };

  const providerName = (provider: TraktProvider) =>
    intl.formatMessage(
      provider === 'direct'
        ? messages.directProvider
        : messages.jellyfinProvider
    );

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.trakt),
          intl.formatMessage(globalMessages.settings),
        ]}
      />

      <header className="mb-6 overflow-hidden rounded-xl border border-gray-700 bg-gray-900/60">
        <div className="border-b border-gray-700 bg-gradient-to-r from-gray-800 to-gray-900 px-5 py-5 sm:px-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="heading">
                  {intl.formatMessage(messages.traktConnection)}
                </h3>
                <Badge badgeType={healthBadge.type}>
                  {intl.formatMessage(healthBadge.message)}
                </Badge>
              </div>
              <p className="description mt-1">
                {intl.formatMessage(messages.description)}
              </p>
            </div>
            <Button
              buttonType="ghost"
              buttonSize="sm"
              type="button"
              onClick={refreshHealth}
              disabled={checking}
            >
              <ArrowPathIcon className={checking ? 'animate-spin' : ''} />
              <span>
                {intl.formatMessage(
                  checking
                    ? messages.checkingConnection
                    : messages.checkConnection
                )}
              </span>
            </Button>
          </div>
        </div>
        <div className="grid gap-4 px-5 py-4 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:px-6">
          <div>
            <div className="text-xs font-medium uppercase tracking-wider text-gray-500">
              {intl.formatMessage(messages.activeMethod)}
            </div>
            <div className="mt-1 font-semibold text-white">
              {providerName(data.provider)}
            </div>
            {activeHealth && (
              <p className="mt-1 leading-5 text-gray-400">
                {activeHealth.detail}
              </p>
            )}
          </div>
          {activeHealth?.checkedAt && (
            <div className="self-end text-xs text-gray-500">
              {intl.formatMessage(messages.checkedAt, {
                time: intl.formatDate(activeHealth.checkedAt, {
                  hour: 'numeric',
                  minute: '2-digit',
                }),
              })}
            </div>
          )}
        </div>
      </header>

      {healthError && (
        <div className="mb-6">
          <Alert
            type="warning"
            title={intl.formatMessage(messages.statusFailure)}
          />
        </div>
      )}

      <fieldset className="mb-7">
        <legend className="text-base font-semibold text-white">
          {intl.formatMessage(messages.connectionMethod)}
        </legend>
        <p className="mt-1 text-sm text-gray-400">
          {intl.formatMessage(messages.connectionMethodHint)}
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {(['direct', 'jellyfin'] as const).map((provider) => {
            const viewed = selectedProvider === provider;
            const active = data.provider === provider;
            const methodHealth = health?.trakt[provider];
            return (
              <label
                key={provider}
                htmlFor={`trakt-provider-${provider}`}
                className={`relative cursor-pointer rounded-xl border p-5 transition focus-within:ring-2 focus-within:ring-indigo-500 ${
                  viewed
                    ? 'border-indigo-400 bg-indigo-500/10 shadow-sm shadow-indigo-950'
                    : 'border-gray-700 bg-gray-900/30 hover:border-gray-500 hover:bg-gray-800/50'
                }`}
              >
                <span className="sr-only">{providerName(provider)}</span>
                <input
                  id={`trakt-provider-${provider}`}
                  type="radio"
                  name="traktProvider"
                  value={provider}
                  checked={viewed}
                  onChange={() => setViewedProvider(provider)}
                  className="sr-only"
                />
                <span className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className={`mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-full border ${
                      viewed
                        ? 'border-indigo-400 bg-indigo-500'
                        : 'border-gray-500 bg-gray-800'
                    }`}
                  >
                    {viewed && (
                      <span className="h-2 w-2 rounded-full bg-white" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-white">
                        {providerName(provider)}
                      </span>
                      {active ? (
                        <Badge badgeType="success">
                          {intl.formatMessage(messages.currentMethod)}
                        </Badge>
                      ) : viewed ? (
                        <Badge badgeType="light">
                          {intl.formatMessage(messages.configureBelow)}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="mt-2 block text-sm leading-5 text-gray-400">
                      {intl.formatMessage(
                        provider === 'direct'
                          ? messages.directProviderDescription
                          : messages.jellyfinProviderDescription
                      )}
                    </span>
                    {methodHealth && (
                      <span className="mt-3 block text-xs leading-5 text-gray-500">
                        {methodHealth.detail}
                      </span>
                    )}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <section className="rounded-xl border border-gray-700 bg-gray-800/35 p-5 sm:p-6">
        {selectedProvider === 'jellyfin' ? (
          <SettingsBetterTrakt
            active={data.provider === 'jellyfin'}
            readiness={health?.trakt.jellyfin.readiness}
            activating={activatingBetter}
            onActivate={() => setBetterConfirmOpen(true)}
          />
        ) : (
          <>
            <div className="mb-6">
              <h4 className="text-lg font-semibold text-white">
                {intl.formatMessage(messages.directSetup)}
              </h4>
              <p className="description mt-1">
                {intl.formatMessage(messages.directSetupDescription)}
              </p>
              <p className="description mt-2">
                {intl.formatMessage(messages.createAppTip, {
                  TraktAppLink: (msg: React.ReactNode) => (
                    <a
                      href="https://trakt.tv/oauth/applications"
                      target="_blank"
                      rel="noreferrer"
                      className="text-white underline decoration-gray-500 underline-offset-2 hover:decoration-white"
                    >
                      {msg}
                    </a>
                  ),
                })}
              </p>
            </div>
            <Formik
              initialValues={{
                clientId: data.provider === 'direct' ? data.clientId : '',
                clientSecret: '',
              }}
              enableReinitialize
              validationSchema={TraktSettingsSchema}
              onSubmit={async (values, helpers) => {
                if (
                  data.provider !== 'direct' ||
                  (credentialsChanging(values) &&
                    (data.linkedAccountCount ?? 0) > 0)
                ) {
                  setPendingSubmit({ values, helpers });
                  setDirectConfirmOpen(true);
                  return;
                }
                await saveDirect(values, helpers);
              }}
            >
              {({ errors, touched, handleSubmit, isSubmitting, isValid }) => (
                <form onSubmit={handleSubmit}>
                  <div className="form-row">
                    <label htmlFor="clientId" className="text-label">
                      {intl.formatMessage(messages.clientId)}
                      <span className="label-required">*</span>
                    </label>
                    <div className="form-input-area">
                      <div className="form-input-field">
                        <Field
                          id="clientId"
                          name="clientId"
                          type="text"
                          autoComplete="off"
                          aria-invalid={Boolean(
                            errors.clientId && touched.clientId
                          )}
                          aria-describedby="clientId-error"
                        />
                      </div>
                      {errors.clientId && touched.clientId && (
                        <div id="clientId-error" className="error">
                          {errors.clientId}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="form-row">
                    <label htmlFor="clientSecret" className="text-label">
                      {intl.formatMessage(messages.clientSecret)}
                      {!(data.provider === 'direct' && data.configured) && (
                        <span className="label-required">*</span>
                      )}
                      {data.provider === 'direct' && data.configured && (
                        <span className="label-tip">
                          {intl.formatMessage(messages.clientSecretTip)}
                        </span>
                      )}
                    </label>
                    <div className="form-input-area">
                      <div className="form-input-field">
                        <SensitiveInput
                          as="field"
                          id="clientSecret"
                          name="clientSecret"
                          autoComplete="off"
                          revealLabel={intl.formatMessage(messages.showSecret)}
                          hideLabel={intl.formatMessage(messages.hideSecret)}
                          aria-invalid={Boolean(
                            errors.clientSecret && touched.clientSecret
                          )}
                          aria-describedby="clientSecret-error"
                        />
                      </div>
                      {errors.clientSecret && touched.clientSecret && (
                        <div id="clientSecret-error" className="error">
                          {errors.clientSecret}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex justify-end border-t border-gray-700 pt-5">
                    <Button
                      buttonType="primary"
                      type="submit"
                      disabled={isSubmitting || !isValid}
                    >
                      {data.provider === 'direct' ? (
                        <ArrowDownOnSquareIcon />
                      ) : (
                        <ArrowRightIcon />
                      )}
                      <span>
                        {intl.formatMessage(
                          data.provider === 'direct'
                            ? messages.saveDirect
                            : messages.switchDirect
                        )}
                      </span>
                    </Button>
                  </div>
                </form>
              )}
            </Formik>
          </>
        )}
      </section>

      <section className="mt-7 rounded-xl border border-gray-700 bg-gray-900/30 p-5 sm:p-6">
        <div className="mb-4">
          <h4 className="text-base font-semibold text-white">
            {intl.formatMessage(messages.behavior)}
          </h4>
          <p className="mt-1 text-sm text-gray-400">
            {intl.formatMessage(messages.behaviorDescription)}
          </p>
        </div>
        <label
          htmlFor="trakt-actions-enabled"
          className="flex cursor-pointer items-start gap-3"
        >
          <span className="sr-only">
            {intl.formatMessage(messages.actionsEnabled)}
          </span>
          <input
            id="trakt-actions-enabled"
            type="checkbox"
            className="form-checkbox mt-1"
            checked={data.actionsEnabled !== false}
            disabled={savingActions}
            onChange={(event) => void updateActions(event.target.checked)}
          />
          <span>
            <span className="flex items-center gap-2 text-sm font-medium text-gray-100">
              {data.actionsEnabled !== false && (
                <CheckCircleIcon className="h-4 w-4 text-green-400" />
              )}
              {intl.formatMessage(messages.actionsEnabled)}
            </span>
            <span className="mt-1 block text-sm leading-5 text-gray-400">
              {intl.formatMessage(messages.actionsEnabledTip)}
            </span>
          </span>
        </label>
      </section>

      <Transition as={Fragment} show={directConfirmOpen}>
        <Modal
          okText={intl.formatMessage(messages.switchDirect)}
          okButtonType={data.provider === 'direct' ? 'danger' : 'primary'}
          onOk={async () => {
            if (!pendingSubmit) return setDirectConfirmOpen(false);
            setDirectConfirmOpen(false);
            await saveDirect(pendingSubmit.values, pendingSubmit.helpers, true);
            setPendingSubmit(null);
          }}
          onCancel={() => {
            pendingSubmit?.helpers.setSubmitting(false);
            setPendingSubmit(null);
            setDirectConfirmOpen(false);
          }}
          title={intl.formatMessage(
            data.provider === 'jellyfin'
              ? messages.directSwitchTitle
              : messages.disconnectConfirmTitle
          )}
        >
          {intl.formatMessage(
            data.provider === 'jellyfin'
              ? messages.directSwitchDescription
              : messages.disconnectConfirmDescription,
            { count: data.linkedAccountCount ?? 0 }
          )}
        </Modal>
      </Transition>

      <Transition as={Fragment} show={betterConfirmOpen}>
        <Modal
          okText={intl.formatMessage(messages.switchBetter)}
          okButtonType="danger"
          onOk={activateBetter}
          onCancel={() => setBetterConfirmOpen(false)}
          title={intl.formatMessage(messages.betterSwitchTitle)}
        >
          {intl.formatMessage(messages.betterSwitchDescription, {
            count: data.linkedAccountCount ?? 0,
          })}
        </Modal>
      </Transition>
    </>
  );
};

export default SettingsTrakt;
