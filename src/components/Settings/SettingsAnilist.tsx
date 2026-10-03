import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import Modal from '@app/components/Common/Modal';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import SettingsBadge from '@app/components/Settings/SettingsBadge';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { TrashIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import { Field, Formik } from 'formik';
import { Fragment, forwardRef, useState, type ReactNode } from 'react';
import { useIntl } from 'react-intl';
import { Link } from 'react-router';
import useSWR, { mutate as globalMutate } from 'swr';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.SettingsAnilist', {
  configureAnilist: 'Configure AniList',
  description:
    'Create an AniList API application, then enter its credentials. Each user authorizes it separately with a PIN.',
  createAppTip:
    'Create an application at <AniListAppLink>anilist.co/settings/developer</AniListAppLink>. Set its Redirect URL to {redirectUrl}.',
  clientId: 'Client ID',
  clientSecret: 'Client Secret',
  validationClientId: 'You must provide a Client ID',
  validationClientSecret: 'You must provide a Client Secret',
  clientSecretTip:
    'A secret is saved. Leave this blank to keep it, or enter a replacement',
  actionsEnabled: 'Allow AniList Watched and Rating Actions',
  actionsEnabledTip:
    'Marking anime watched or rated in Foreseerr also updates the linked AniList account',
  anilistExperimentalTooltip:
    'Anime seasons and episodes do not always match TMDB one-to-one, so watches can land on the wrong AniList title or be skipped.',
  loadFailed: 'Unable to load AniList settings.',
  toastSettingsSuccess: 'AniList settings saved successfully!',
  toastSettingsFailure: 'Something went wrong while saving AniList settings.',
  clearCredentials: 'Remove Credentials',
  clearConfirmTitle: 'Remove AniList credentials?',
  clearConfirmDescription:
    'This will disconnect {count, plural, one {# linked AniList account} other {# linked AniList accounts}}.',
  disconnectConfirmTitle: 'Replace AniList credentials?',
  disconnectConfirmDescription:
    'Replacing these credentials will disconnect {count, plural, one {# linked AniList account} other {# linked AniList accounts}}. Those users must authorize the application again.',
  confirmReplace: 'Replace Credentials',
  mappingPacksMissing: 'Anime mapping data is not loaded',
  mappingPacksMissingTip:
    'Foreseerr matches anime to TMDB with datasets it downloads on its own, and none is loaded yet. Until one is, some anime may not show up or be requestable. Check <MappingLink>Mapping settings</MappingLink>.',
});

interface AnilistSettingsResponse {
  clientId: string;
  clientSecret: string;
  configured: boolean;
  actionsEnabled: boolean;
  redirectUrl: string;
  linkedAccountCount?: number;
}

interface AnilistFormValues {
  clientId: string;
  clientSecret: string;
  actionsEnabled: boolean;
}

type SettingsAnilistProps = {
  onClose: () => void;
};

const SettingsAnilist = forwardRef<HTMLDivElement, SettingsAnilistProps>(
  ({ onClose }, ref) => {
    const intl = useIntl();
    const { addToast } = useToasts();
    const { data, error, mutate } = useSWR<AnilistSettingsResponse>(
      '/api/v1/settings/anilist'
    );
    const { data: mappingStatus } = useSWR<{
      datasets: { enabled: boolean; edgeCount: number | null }[];
    }>('/api/v1/settings/mapping/status');
    const mappingPacksMissing =
      !!mappingStatus &&
      !mappingStatus.datasets.some(
        (dataset) => dataset.enabled && !!dataset.edgeCount
      );
    const [pending, setPending] = useState<{
      values: AnilistFormValues;
      clear: boolean;
    }>();
    const linkedAccountCount = data?.linkedAccountCount ?? 0;

    const save = async (
      values: AnilistFormValues,
      { confirmed = false, clear = false } = {}
    ) => {
      try {
        await axios.post('/api/v1/settings/anilist', {
          clientId: values.clientId.trim(),
          clientSecret: values.clientSecret.trim(),
          actionsEnabled: values.actionsEnabled,
          confirmDisconnectLinkedAccounts: confirmed,
          clearCredentials: clear,
        });
        addToast(intl.formatMessage(messages.toastSettingsSuccess), {
          appearance: 'success',
          autoDismiss: true,
        });
        onClose();
      } catch (e) {
        addToast(
          axios.isAxiosError(e) && typeof e.response?.data?.message === 'string'
            ? e.response.data.message
            : intl.formatMessage(messages.toastSettingsFailure),
          { appearance: 'error', autoDismiss: true }
        );
      } finally {
        mutate();
        globalMutate('/api/v1/settings/public');
        globalMutate('/api/v1/settings/integrations/status');
      }
    };

    return (
      <Formik<AnilistFormValues>
        initialValues={{
          clientId: data?.clientId ?? '',
          clientSecret: '',
          actionsEnabled: data?.actionsEnabled !== false,
        }}
        enableReinitialize
        validationSchema={Yup.object().shape({
          clientId: Yup.string()
            .trim()
            .required(intl.formatMessage(messages.validationClientId)),
          clientSecret: data?.configured
            ? Yup.string()
            : Yup.string()
                .trim()
                .required(intl.formatMessage(messages.validationClientSecret)),
        })}
        onSubmit={async (values) => {
          const credentialsChanging =
            values.clientId.trim() !== data?.clientId ||
            Boolean(values.clientSecret.trim());
          if (
            credentialsChanging &&
            data?.configured &&
            linkedAccountCount > 0
          ) {
            setPending({ values, clear: false });
            return;
          }
          await save(values);
        }}
      >
        {({ errors, touched, handleSubmit, isSubmitting, isValid, values }) => (
          <Modal
            ref={ref}
            title={intl.formatMessage(messages.configureAnilist)}
            loading={!data && !error}
            backgroundClickable={false}
            onCancel={onClose}
            okText={intl.formatMessage(
              isSubmitting ? globalMessages.saving : globalMessages.save
            )}
            okDisabled={isSubmitting || !isValid || !data}
            onOk={() => handleSubmit()}
          >
            {error || !data ? (
              <Alert
                type="error"
                title={intl.formatMessage(messages.loadFailed)}
              />
            ) : (
              <form onSubmit={handleSubmit}>
                {mappingPacksMissing && (
                  <Alert
                    title={intl.formatMessage(messages.mappingPacksMissing)}
                  >
                    {intl.formatMessage(messages.mappingPacksMissingTip, {
                      MappingLink: (msg: ReactNode) => (
                        <Link
                          to="/settings/mapping"
                          className="text-white underline transition hover:text-gray-200"
                        >
                          {msg}
                        </Link>
                      ),
                    })}
                  </Alert>
                )}
                <p className="description">
                  {intl.formatMessage(messages.description)}{' '}
                  {intl.formatMessage(messages.createAppTip, {
                    redirectUrl: data.redirectUrl,
                    AniListAppLink: (msg: ReactNode) => (
                      <a
                        href="https://anilist.co/settings/developer"
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
                  <label htmlFor="anilistClientId" className="text-label">
                    {intl.formatMessage(messages.clientId)}
                    <span className="label-required">*</span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        id="anilistClientId"
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
                  <label htmlFor="anilistClientSecret" className="text-label">
                    {intl.formatMessage(messages.clientSecret)}
                    {data.configured ? (
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
                        id="anilistClientSecret"
                        name="clientSecret"
                        autoComplete="off"
                      />
                    </div>
                    {errors.clientSecret && touched.clientSecret && (
                      <div className="error">{errors.clientSecret}</div>
                    )}
                    {data.configured && (
                      <Button
                        className="mt-3"
                        buttonType="danger"
                        buttonSize="sm"
                        type="button"
                        onClick={() => setPending({ values, clear: true })}
                      >
                        <TrashIcon />
                        <span>
                          {intl.formatMessage(messages.clearCredentials)}
                        </span>
                      </Button>
                    )}
                  </div>
                </div>
                <div className="form-row">
                  <label
                    htmlFor="anilistActionsEnabled"
                    className="checkbox-label"
                  >
                    <span className="mr-2">
                      {intl.formatMessage(messages.actionsEnabled)}
                    </span>
                    <SettingsBadge
                      badgeType="experimental"
                      tooltip={intl.formatMessage(
                        messages.anilistExperimentalTooltip
                      )}
                    />
                    <span className="label-tip">
                      {intl.formatMessage(messages.actionsEnabledTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="checkbox"
                      id="anilistActionsEnabled"
                      name="actionsEnabled"
                    />
                  </div>
                </div>
              </form>
            )}
            <Transition as={Fragment} show={!!pending}>
              <Modal
                title={intl.formatMessage(
                  pending?.clear
                    ? messages.clearConfirmTitle
                    : messages.disconnectConfirmTitle
                )}
                okButtonType="danger"
                okText={intl.formatMessage(
                  pending?.clear
                    ? messages.clearCredentials
                    : messages.confirmReplace
                )}
                onOk={async () => {
                  if (!pending) return;
                  const { values: pendingValues, clear } = pending;
                  setPending(undefined);
                  await save(pendingValues, { confirmed: true, clear });
                }}
                onCancel={() => setPending(undefined)}
              >
                {intl.formatMessage(
                  pending?.clear
                    ? messages.clearConfirmDescription
                    : messages.disconnectConfirmDescription,
                  { count: linkedAccountCount }
                )}
              </Modal>
            </Transition>
          </Modal>
        )}
      </Formik>
    );
  }
);

SettingsAnilist.displayName = 'SettingsAnilist';

export default SettingsAnilist;
