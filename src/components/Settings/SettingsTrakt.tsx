import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import PageTitle from '@app/components/Common/PageTitle';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import SettingsBetterTrakt from '@app/components/Settings/SettingsBetterTrakt';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import { Field, Formik, type FormikHelpers } from 'formik';
import { Fragment, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate as globalMutate } from 'swr';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.SettingsTrakt', {
  trakt: 'Trakt',
  traktSettings: 'Trakt Settings',
  traktSettingsDescription:
    'Choose how Foreseer connects users to Trakt for personalized recommendations, lists, and watchlists.',
  directTab: 'Trakt API application',
  betterTab: 'Better Trakt (Jellyfin)',
  clientId: 'Client ID',
  clientSecret: 'Client Secret',
  actionsEnabled: 'Enable watched / rate actions',
  actionsEnabledTip:
    'When enabled, linked users can mark titles watched/unwatched and give a score from title posters. Actions fan out to every enabled provider (Trakt is the first).',
  validationClientId: 'You must provide a Client ID',
  validationClientSecret: 'You must provide a Client Secret',
  toastSettingsSuccess: 'Trakt settings saved successfully!',
  toastSettingsFailure: 'Something went wrong while saving Trakt settings.',
  createAppTip:
    'Create an API app at <TraktAppLink>trakt.tv/oauth/applications</TraktAppLink>. Set its redirect URI to urn:ietf:wg:oauth:2.0:oob so token refreshes match the application configuration.',
  configured: 'Configured',
  notConfigured: 'Not Configured',
  disconnectConfirmTitle: 'Disconnect linked Trakt accounts?',
  disconnectConfirmDescription:
    'Changing application credentials will disconnect {count, plural, one {# linked user account} other {# linked user accounts}}. Users will need to link Trakt again after you save.',
  clientSecretTip:
    'The saved secret is never shown. Leave blank to keep the current secret, or paste a new secret to replace it.',
});

interface TraktSettingsResponse {
  provider: 'direct' | 'jellyfin';
  clientId: string;
  clientSecret: string;
  configured: boolean;
  actionsEnabled: boolean;
  linkedAccountCount?: number;
}

interface TraktFormValues {
  clientId: string;
  clientSecret: string;
  actionsEnabled: boolean;
}

type SettingsTraktProps = {
  onSave?: () => void;
};

const SettingsTrakt = ({ onSave }: SettingsTraktProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<TraktSettingsResponse>(
    '/api/v1/settings/trakt'
  );
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [showBetterTrakt, setShowBetterTrakt] = useState(false);
  const [pendingSubmit, setPendingSubmit] = useState<{
    values: TraktFormValues;
    helpers: FormikHelpers<TraktFormValues>;
  } | null>(null);

  const TraktSettingsSchema = Yup.object().shape({
    clientId: Yup.string()
      .trim()
      .required(intl.formatMessage(messages.validationClientId)),
    clientSecret: Yup.string()
      .trim()
      .test(
        'clientSecret-required',
        intl.formatMessage(messages.validationClientSecret),
        (value) => {
          if (data?.provider === 'direct' && data.configured) {
            return true;
          }
          return Boolean(value);
        }
      ),
  });

  const credentialsChanging = (values: TraktFormValues) => {
    if (!data) {
      return false;
    }
    const secretUnchanged =
      values.clientSecret.trim() === '' ||
      values.clientSecret.trim() === '********';
    return (
      values.clientId.trim() !== (data.clientId ?? '').trim() ||
      (!secretUnchanged &&
        values.clientSecret.trim() !== (data.clientSecret ?? '').trim())
    );
  };

  const saveSettings = async (
    values: TraktFormValues,
    helpers: FormikHelpers<TraktFormValues>,
    confirmDisconnectLinkedAccounts = false
  ) => {
    try {
      await axios.post('/api/v1/settings/trakt', {
        provider: 'direct',
        clientId: values.clientId.trim(),
        clientSecret: values.clientSecret.trim(),
        actionsEnabled: values.actionsEnabled,
        ...(confirmDisconnectLinkedAccounts
          ? { confirmDisconnectLinkedAccounts: true }
          : {}),
      });
      addToast(intl.formatMessage(messages.toastSettingsSuccess), {
        autoDismiss: true,
        appearance: 'success',
      });
      onSave?.();
    } catch {
      addToast(intl.formatMessage(messages.toastSettingsFailure), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      helpers.setSubmitting(false);
      mutate();
      globalMutate('/api/v1/settings/public');
    }
  };

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.trakt),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">
          {intl.formatMessage(messages.traktSettings)}
          <Badge
            badgeType={data?.configured ? 'success' : 'warning'}
            className="ml-2"
          >
            {intl.formatMessage(
              data?.configured ? messages.configured : messages.notConfigured
            )}
          </Badge>
        </h3>
        <p className="description">
          {intl.formatMessage(messages.traktSettingsDescription)}
        </p>
        {!showBetterTrakt && (
          <p className="description mt-2">
            {intl.formatMessage(messages.createAppTip, {
              TraktAppLink: (msg: React.ReactNode) => (
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
        )}
      </div>
      <div
        role="tablist"
        aria-label={intl.formatMessage(messages.traktSettings)}
        className="mb-6 flex gap-6 border-b border-gray-700"
      >
        <button
          type="button"
          role="tab"
          aria-selected={!showBetterTrakt}
          onClick={() => setShowBetterTrakt(false)}
          className={`-mb-px border-b-2 px-1 pb-3 text-sm font-medium transition ${
            !showBetterTrakt
              ? 'border-white text-white'
              : 'border-transparent text-gray-400 hover:text-gray-200'
          }`}
        >
          {intl.formatMessage(messages.directTab)}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={showBetterTrakt}
          onClick={() => setShowBetterTrakt(true)}
          className={`-mb-px border-b-2 px-1 pb-3 text-sm font-medium transition ${
            showBetterTrakt
              ? 'border-white text-white'
              : 'border-transparent text-gray-400 hover:text-gray-200'
          }`}
        >
          {intl.formatMessage(messages.betterTab)}
        </button>
      </div>
      <div role="tabpanel">
        {showBetterTrakt ? (
          <SettingsBetterTrakt />
        ) : (
          <Formik
            initialValues={{
              clientId: data?.clientId ?? '',
              // Never seed the masked placeholder — reveal would only show asterisks.
              // Empty field: leave blank to keep the current secret (server preserves).
              clientSecret: '',
              actionsEnabled: data?.actionsEnabled !== false,
            }}
            enableReinitialize
            validationSchema={TraktSettingsSchema}
            onSubmit={async (values, helpers) => {
              const linkedCount = data?.linkedAccountCount ?? 0;
              if (credentialsChanging(values) && linkedCount > 0) {
                setPendingSubmit({ values, helpers });
                setConfirmModalOpen(true);
                return;
              }

              await saveSettings(values, helpers);
            }}
          >
            {({
              errors,
              touched,
              values,
              handleSubmit,
              isSubmitting,
              isValid,
              setFieldValue,
            }) => (
              <form className="section" onSubmit={handleSubmit}>
                <>
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
                        />
                      </div>
                      {errors.clientId &&
                        touched.clientId &&
                        typeof errors.clientId === 'string' && (
                          <div className="error">{errors.clientId}</div>
                        )}
                    </div>
                  </div>
                  <div className="form-row">
                    <label htmlFor="clientSecret" className="text-label">
                      {intl.formatMessage(messages.clientSecret)}
                      {!(data?.provider === 'direct' && data.configured) && (
                        <span className="label-required">*</span>
                      )}
                      {data?.provider === 'direct' && data.configured && (
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
                        />
                      </div>
                      {errors.clientSecret &&
                        touched.clientSecret &&
                        typeof errors.clientSecret === 'string' && (
                          <div className="error">{errors.clientSecret}</div>
                        )}
                    </div>
                  </div>
                </>
                <div className="form-row">
                  <label htmlFor="actionsEnabled" className="text-label">
                    {intl.formatMessage(messages.actionsEnabled)}
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="checkbox"
                      id="actionsEnabled"
                      name="actionsEnabled"
                      onChange={() =>
                        setFieldValue('actionsEnabled', !values.actionsEnabled)
                      }
                    />
                    <p className="text-sm text-gray-400">
                      {intl.formatMessage(messages.actionsEnabledTip)}
                    </p>
                  </div>
                </div>
                <div className="actions">
                  <div className="flex justify-end">
                    <span className="ml-3 inline-flex rounded-md shadow-sm">
                      <Button
                        buttonType="primary"
                        type="submit"
                        disabled={isSubmitting || !isValid}
                      >
                        <ArrowDownOnSquareIcon />
                        <span>
                          {isSubmitting
                            ? intl.formatMessage(globalMessages.saving)
                            : intl.formatMessage(globalMessages.save)}
                        </span>
                      </Button>
                    </span>
                  </div>
                </div>
              </form>
            )}
          </Formik>
        )}
      </div>
      <Transition
        as={Fragment}
        show={confirmModalOpen}
        enter="transition-opacity ease-in-out duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity ease-in-out duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
      >
        <Modal
          okText={intl.formatMessage(globalMessages.save)}
          okButtonType="danger"
          onOk={async () => {
            if (!pendingSubmit) {
              setConfirmModalOpen(false);
              return;
            }
            setConfirmModalOpen(false);
            await saveSettings(
              pendingSubmit.values,
              pendingSubmit.helpers,
              true
            );
            setPendingSubmit(null);
          }}
          onCancel={() => {
            pendingSubmit?.helpers.setSubmitting(false);
            setPendingSubmit(null);
            setConfirmModalOpen(false);
          }}
          title={intl.formatMessage(messages.disconnectConfirmTitle)}
        >
          {intl.formatMessage(messages.disconnectConfirmDescription, {
            count: data?.linkedAccountCount ?? 0,
          })}
        </Modal>
      </Transition>
    </>
  );
};

export default SettingsTrakt;
