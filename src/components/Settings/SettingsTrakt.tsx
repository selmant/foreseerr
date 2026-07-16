import Badge from '@app/components/Common/Badge';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import { Field, Formik } from 'formik';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.SettingsTrakt', {
  trakt: 'Trakt',
  traktSettings: 'Trakt Settings',
  traktSettingsDescription:
    'Configure your Trakt API application credentials. Users can then link their Trakt accounts to browse personalized recommendations, lists, and watchlists.',
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
    'Create an API app at <TraktAppLink>trakt.tv/oauth/applications</TraktAppLink>. Use the device authentication flow (no redirect URI required).',
  configured: 'Configured',
  notConfigured: 'Not Configured',
});

interface TraktSettingsResponse {
  clientId: string;
  clientSecret: string;
  configured: boolean;
  actionsEnabled: boolean;
}

const SettingsTrakt = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<TraktSettingsResponse>(
    '/api/v1/settings/trakt'
  );

  const TraktSettingsSchema = Yup.object().shape({
    clientId: Yup.string()
      .trim()
      .required(intl.formatMessage(messages.validationClientId)),
    clientSecret: Yup.string()
      .trim()
      .required(intl.formatMessage(messages.validationClientSecret)),
  });

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
      </div>
      <Formik
        initialValues={{
          clientId: data?.clientId ?? '',
          clientSecret: data?.clientSecret ?? '',
          actionsEnabled: data?.actionsEnabled !== false,
        }}
        enableReinitialize
        validationSchema={TraktSettingsSchema}
        onSubmit={async (values) => {
          try {
            await axios.post('/api/v1/settings/trakt', {
              clientId: values.clientId.trim(),
              clientSecret: values.clientSecret.trim(),
              actionsEnabled: values.actionsEnabled,
            });
            addToast(intl.formatMessage(messages.toastSettingsSuccess), {
              autoDismiss: true,
              appearance: 'success',
            });
          } catch {
            addToast(intl.formatMessage(messages.toastSettingsFailure), {
              autoDismiss: true,
              appearance: 'error',
            });
          } finally {
            mutate();
          }
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
                <span className="label-required">*</span>
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
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={isSubmitting || !isValid}
                  >
                    <ArrowDownOnSquareIcon />
                    <span>
                      {isSubmitting
                        ? intl.formatMessage(globalMessages.saving)
                        : intl.formatMessage(globalMessages.save)}
                    </span>
                  </button>
                </span>
              </div>
            </div>
          </form>
        )}
      </Formik>
    </>
  );
};

export default SettingsTrakt;
