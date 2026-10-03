import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import Modal from '@app/components/Common/Modal';
import SegmentedControl from '@app/components/Common/SegmentedControl';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import SettingsBetterTrakt, {
  type BetterTraktReadiness,
} from '@app/components/Settings/SettingsBetterTrakt';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { ArrowPathIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import { Field, Formik } from 'formik';
import { Fragment, forwardRef, useState, type ReactNode } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate as globalMutate } from 'swr';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.SettingsTrakt', {
  configureTrakt: 'Configure Trakt',
  description:
    'Choose the single server-wide method Foreseerr uses for every user’s Trakt activity.',
  activeMethod: 'Active Method',
  connectionMethod: 'Connection Method',
  connectionMethodHint: 'Applies to every Foreseerr user',
  direct: 'Direct Trakt',
  jellyfin: 'Better Trakt',
  directProvider: 'Direct Trakt app',
  directProviderDescription:
    'Foreseerr connects to Trakt directly. Each user authorizes this server’s Trakt application.',
  jellyfinProvider: 'Better Trakt via Jellyfin',
  jellyfinProviderDescription:
    'Foreseerr uses each linked Jellyfin user’s Better Trakt connection and permissions.',
  checkedAt: 'Checked {time}',
  checkConnection: 'Check Connection',
  checkingConnection: 'Checking…',
  connected: 'Reachable',
  actionRequired: 'Action Required',
  notConfigured: 'Not Configured',
  unknown: 'Status Unavailable',
  statusFailure: 'Foreseerr could not check the integration status.',
  settingsFailure: 'Foreseerr could not load the saved Trakt settings.',
  directSetup: 'Direct Application Setup',
  directSetupDescription:
    'Create a Trakt application, then enter its credentials below. Each Foreseerr user will authorize it separately.',
  createAppTip:
    'Create an API app at <TraktAppLink>trakt.tv/oauth/applications</TraktAppLink>. Set its redirect URI to urn:ietf:wg:oauth:2.0:oob.',
  clientId: 'Client ID',
  clientSecret: 'Client Secret',
  validationClientId: 'You must provide a Client ID',
  validationClientSecret: 'You must provide a Client Secret',
  clientSecretTip:
    'A secret is saved. Leave this blank to keep it, or enter a replacement',
  showSecret: 'Show Client Secret',
  hideSecret: 'Hide Client Secret',
  behavior: 'Shared Behavior',
  behaviorDescription:
    'These controls apply whichever Trakt connection method is active.',
  actionsEnabled: 'Allow Trakt Watched and Rating Actions',
  actionsEnabledTip:
    'This only controls Trakt. Jellyfin watched status still works when the user is linked to Jellyfin',
  toastSettingsSuccess: 'Trakt settings saved successfully!',
  toastSettingsFailure: 'Something went wrong while saving Trakt settings.',
  toastHealthFailure: 'Unable to check the Trakt connection.',
  directSwitchTitle: 'Switch to Direct Trakt?',
  directSwitchDescription:
    'Foreseerr will stop using Better Trakt. Jellyfin connections remain intact, but each Foreseerr user must authorize this Direct Trakt application.',
  switchDirect: 'Switch to Direct Trakt',
  disconnectConfirmTitle: 'Replace Direct Trakt credentials?',
  disconnectConfirmDescription:
    'Replacing these credentials will disconnect {count, plural, one {# linked Trakt account} other {# linked Trakt accounts}}. Those users must authorize the application again.',
  confirmReplace: 'Replace Credentials',
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
  provider: TraktProvider;
  clientId: string;
  clientSecret: string;
  actionsEnabled: boolean;
}

type PendingConfirmation = {
  values: TraktFormValues;
  kind: 'better' | 'direct' | 'replace';
};

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
  onClose: () => void;
};

const SettingsTrakt = forwardRef<HTMLDivElement, SettingsTraktProps>(
  ({ onClose }, ref) => {
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
    const [checking, setChecking] = useState(false);
    const [pending, setPending] = useState<PendingConfirmation>();
    const linkedAccountCount = data?.linkedAccountCount ?? 0;
    const directConfigured = data?.provider === 'direct' && data.configured;
    const activeHealth = health?.trakt;

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

    const save = async (values: TraktFormValues, confirmed = false) => {
      try {
        await axios.post('/api/v1/settings/trakt', {
          provider: values.provider,
          clientId: values.clientId.trim(),
          clientSecret: values.clientSecret.trim(),
          actionsEnabled: values.actionsEnabled,
          ...(confirmed
            ? {
                confirmProviderSwitch: true,
                confirmDisconnectLinkedAccounts: true,
              }
            : {}),
        });
        addToast(intl.formatMessage(messages.toastSettingsSuccess), {
          autoDismiss: true,
          appearance: 'success',
        });
        onClose();
      } catch (e) {
        addToast(
          axios.isAxiosError(e) && typeof e.response?.data?.message === 'string'
            ? e.response.data.message
            : intl.formatMessage(messages.toastSettingsFailure),
          { autoDismiss: true, appearance: 'error' }
        );
      } finally {
        await Promise.all([
          mutateSettings(),
          mutateHealth(),
          globalMutate('/api/v1/settings/public'),
          globalMutate(
            (key) =>
              typeof key === 'string' &&
              key.startsWith('/api/v1/media-actions/')
          ),
        ]);
      }
    };

    const credentialsChanging = (values: TraktFormValues) =>
      values.clientId.trim() !== (data?.clientId ?? '').trim() ||
      values.clientSecret.trim() !== '';

    const healthBadge = activeHealth
      ? activeHealth.state === 'healthy'
        ? { type: 'success' as const, message: messages.connected }
        : activeHealth.state === 'degraded'
          ? { type: 'danger' as const, message: messages.actionRequired }
          : { type: 'warning' as const, message: messages.notConfigured }
      : { type: 'light' as const, message: messages.unknown };

    return (
      <Formik<TraktFormValues>
        initialValues={{
          provider: data?.provider ?? 'direct',
          clientId: data?.provider === 'direct' ? data.clientId : '',
          clientSecret: '',
          actionsEnabled: data?.actionsEnabled !== false,
        }}
        enableReinitialize
        validationSchema={Yup.object().shape({
          clientId: Yup.string().when('provider', {
            is: 'direct',
            then: (schema) =>
              schema
                .trim()
                .required(intl.formatMessage(messages.validationClientId)),
          }),
          clientSecret: Yup.string().when('provider', {
            is: (provider: TraktProvider) =>
              provider === 'direct' && !directConfigured,
            then: (schema) =>
              schema
                .trim()
                .required(intl.formatMessage(messages.validationClientSecret)),
          }),
        })}
        onSubmit={async (values) => {
          if (!data) return;
          if (values.provider !== data.provider) {
            setPending({
              values,
              kind: values.provider === 'jellyfin' ? 'better' : 'direct',
            });
            return;
          }
          if (
            values.provider === 'direct' &&
            credentialsChanging(values) &&
            linkedAccountCount > 0
          ) {
            setPending({ values, kind: 'replace' });
            return;
          }
          await save(values);
        }}
      >
        {({
          errors,
          touched,
          handleSubmit,
          isSubmitting,
          isValid,
          setFieldValue,
          values,
        }) => {
          const switching = !!data && values.provider !== data.provider;
          return (
            <Modal
              ref={ref}
              title={intl.formatMessage(messages.configureTrakt)}
              loading={!data && !error}
              backgroundClickable={false}
              onCancel={onClose}
              okText={intl.formatMessage(
                isSubmitting
                  ? globalMessages.saving
                  : switching
                    ? values.provider === 'jellyfin'
                      ? messages.switchBetter
                      : messages.switchDirect
                    : globalMessages.save
              )}
              okDisabled={isSubmitting || !isValid || !data}
              onOk={() => handleSubmit()}
            >
              {error || !data ? (
                <Alert
                  type="error"
                  title={intl.formatMessage(messages.settingsFailure)}
                />
              ) : (
                <form onSubmit={handleSubmit}>
                  <p className="description">
                    {intl.formatMessage(messages.description)}
                  </p>
                  {healthError && (
                    <div className="mt-4">
                      <Alert
                        type="warning"
                        title={intl.formatMessage(messages.statusFailure)}
                      />
                    </div>
                  )}
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-gray-700 bg-gray-900/40 px-4 py-3">
                    <div className="min-w-[16rem] flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-gray-400">
                          {intl.formatMessage(messages.activeMethod)}
                        </span>
                        <span className="font-semibold text-white">
                          {intl.formatMessage(
                            data.provider === 'direct'
                              ? messages.directProvider
                              : messages.jellyfinProvider
                          )}
                        </span>
                        <Badge badgeType={healthBadge.type}>
                          {intl.formatMessage(healthBadge.message)}
                        </Badge>
                      </div>
                      {activeHealth && (
                        <p className="mt-1 text-gray-400">
                          {activeHealth.detail}
                          {activeHealth.checkedAt && (
                            <span className="text-gray-500">
                              {' · '}
                              {intl.formatMessage(messages.checkedAt, {
                                time: intl.formatDate(activeHealth.checkedAt, {
                                  hour: 'numeric',
                                  minute: '2-digit',
                                }),
                              })}
                            </span>
                          )}
                        </p>
                      )}
                    </div>
                    <Button
                      buttonType="ghost"
                      buttonSize="sm"
                      type="button"
                      onClick={refreshHealth}
                      disabled={checking}
                    >
                      <ArrowPathIcon
                        className={checking ? 'animate-spin' : ''}
                      />
                      <span>
                        {intl.formatMessage(
                          checking
                            ? messages.checkingConnection
                            : messages.checkConnection
                        )}
                      </span>
                    </Button>
                  </div>

                  <div className="form-row">
                    <span className="group-label sm:mt-2">
                      {intl.formatMessage(messages.connectionMethod)}
                      <span className="label-tip">
                        {intl.formatMessage(messages.connectionMethodHint)}
                      </span>
                    </span>
                    <div className="form-input-area">
                      <SegmentedControl<TraktProvider>
                        ariaLabel={intl.formatMessage(
                          messages.connectionMethod
                        )}
                        value={values.provider}
                        onChange={(provider) =>
                          setFieldValue('provider', provider)
                        }
                        options={[
                          {
                            value: 'direct',
                            label: intl.formatMessage(messages.direct),
                          },
                          {
                            value: 'jellyfin',
                            label: intl.formatMessage(messages.jellyfin),
                          },
                        ]}
                      />
                      <p className="mt-2 text-sm text-gray-400">
                        {intl.formatMessage(
                          values.provider === 'direct'
                            ? messages.directProviderDescription
                            : messages.jellyfinProviderDescription
                        )}
                      </p>
                    </div>
                  </div>

                  {values.provider === 'jellyfin' ? (
                    <SettingsBetterTrakt
                      readiness={health?.trakt.jellyfin.readiness}
                    />
                  ) : (
                    <>
                      <h4 className="mt-8 text-lg font-semibold text-gray-100">
                        {intl.formatMessage(messages.directSetup)}
                      </h4>
                      <p className="description">
                        {intl.formatMessage(messages.directSetupDescription)}{' '}
                        {intl.formatMessage(messages.createAppTip, {
                          TraktAppLink: (msg: ReactNode) => (
                            <a
                              href="https://trakt.tv/oauth/applications"
                              target="_blank"
                              rel="noreferrer"
                              className="text-white underline transition hover:text-gray-200"
                            >
                              {msg}
                            </a>
                          ),
                        })}
                      </p>
                      <div className="form-row">
                        <label htmlFor="traktClientId" className="text-label">
                          {intl.formatMessage(messages.clientId)}
                          <span className="label-required">*</span>
                        </label>
                        <div className="form-input-area">
                          <div className="form-input-field">
                            <Field
                              id="traktClientId"
                              name="clientId"
                              type="text"
                              autoComplete="off"
                            />
                          </div>
                          {errors.clientId && touched.clientId && (
                            <div className="error">{errors.clientId}</div>
                          )}
                        </div>
                      </div>
                      <div className="form-row">
                        <label
                          htmlFor="traktClientSecret"
                          className="text-label"
                        >
                          {intl.formatMessage(messages.clientSecret)}
                          {directConfigured ? (
                            <span className="label-tip">
                              {intl.formatMessage(messages.clientSecretTip)}
                            </span>
                          ) : (
                            <span className="label-required">*</span>
                          )}
                        </label>
                        <div className="form-input-area">
                          <div className="form-input-field">
                            <SensitiveInput
                              as="field"
                              id="traktClientSecret"
                              name="clientSecret"
                              autoComplete="off"
                              revealLabel={intl.formatMessage(
                                messages.showSecret
                              )}
                              hideLabel={intl.formatMessage(
                                messages.hideSecret
                              )}
                            />
                          </div>
                          {errors.clientSecret && touched.clientSecret && (
                            <div className="error">{errors.clientSecret}</div>
                          )}
                        </div>
                      </div>
                    </>
                  )}

                  <h4 className="mt-8 text-lg font-semibold text-gray-100">
                    {intl.formatMessage(messages.behavior)}
                  </h4>
                  <p className="description">
                    {intl.formatMessage(messages.behaviorDescription)}
                  </p>
                  <div className="form-row">
                    <label
                      htmlFor="traktActionsEnabled"
                      className="checkbox-label"
                    >
                      {intl.formatMessage(messages.actionsEnabled)}
                      <span className="label-tip">
                        {intl.formatMessage(messages.actionsEnabledTip)}
                      </span>
                    </label>
                    <div className="form-input-area">
                      <Field
                        type="checkbox"
                        id="traktActionsEnabled"
                        name="actionsEnabled"
                      />
                    </div>
                  </div>
                </form>
              )}
              <Transition as={Fragment} show={!!pending}>
                <Modal
                  title={intl.formatMessage(
                    pending?.kind === 'better'
                      ? messages.betterSwitchTitle
                      : pending?.kind === 'direct'
                        ? messages.directSwitchTitle
                        : messages.disconnectConfirmTitle
                  )}
                  okText={intl.formatMessage(
                    pending?.kind === 'better'
                      ? messages.switchBetter
                      : pending?.kind === 'direct'
                        ? messages.switchDirect
                        : messages.confirmReplace
                  )}
                  okButtonType={
                    pending?.kind === 'direct' ? 'primary' : 'danger'
                  }
                  onOk={async () => {
                    if (!pending) return;
                    const confirmedValues = pending.values;
                    setPending(undefined);
                    await save(confirmedValues, true);
                  }}
                  onCancel={() => setPending(undefined)}
                >
                  {intl.formatMessage(
                    pending?.kind === 'better'
                      ? messages.betterSwitchDescription
                      : pending?.kind === 'direct'
                        ? messages.directSwitchDescription
                        : messages.disconnectConfirmDescription,
                    { count: linkedAccountCount }
                  )}
                </Modal>
              </Transition>
            </Modal>
          );
        }}
      </Formik>
    );
  }
);

SettingsTrakt.displayName = 'SettingsTrakt';

export default SettingsTrakt;
