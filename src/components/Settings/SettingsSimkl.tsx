import Alert from '@app/components/Common/Alert';
import Modal from '@app/components/Common/Modal';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import axios from 'axios';
import { Field, Formik } from 'formik';
import { Fragment, forwardRef, useState, type ReactNode } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate as globalMutate } from 'swr';

const messages = defineMessages('components.Settings.SettingsSimkl', {
  configureSimkl: 'Configure Simkl',
  description:
    'Each user links their own Simkl account with a code, through Foreseerr’s Simkl app. Nothing needs to be registered on Simkl.',
  enabled: 'Enable Simkl',
  enabledTip:
    'Simkl Discover rows, linked accounts, and watched and rating actions',
  clientId: 'Custom Client ID',
  createAppTip:
    'Optional. Leave empty to use Foreseerr’s app. To use your own, create an AUTH V2 application of type “TV, devices & command line” at <SimklAppLink>simkl.com/settings/developer</SimklAppLink>. AUTH V1 applications keep working until Simkl retires them.',
  actionsEnabled: 'Allow Simkl Watched and Rating Actions',
  actionsEnabledTip:
    'Marking titles watched or rated in Foreseerr also updates the linked Simkl account',
  showCommunityRating: 'Show Community Ratings on Details',
  posterCommunityRating: 'Show Community Ratings on Posters',
  loadFailed: 'Unable to load Simkl settings.',
  toastSettingsSuccess: 'Simkl settings saved successfully!',
  toastSettingsFailure: 'Something went wrong while saving Simkl settings.',
  disconnectConfirmTitle: 'Replace Simkl Client ID?',
  disconnectConfirmDescription:
    'Changing the Client ID will disconnect {count, plural, one {# linked Simkl account} other {# linked Simkl accounts}}. Those users must link Simkl again.',
  confirmReplace: 'Replace Client ID',
});

type SimklSettings = {
  enabled: boolean;
  clientId: string;
  configured: boolean;
  actionsEnabled: boolean;
  showCommunityRating: boolean;
  posterCommunityRating: boolean;
  linkedAccountCount: number;
};

type SimklFormValues = Pick<
  SimklSettings,
  | 'enabled'
  | 'clientId'
  | 'actionsEnabled'
  | 'showCommunityRating'
  | 'posterCommunityRating'
>;

type SettingsSimklProps = {
  onClose: () => void;
};

const SettingsSimkl = forwardRef<HTMLDivElement, SettingsSimklProps>(
  ({ onClose }, ref) => {
    const intl = useIntl();
    const { addToast } = useToasts();
    const { data, error, mutate } = useSWR<SimklSettings>(
      '/api/v1/settings/simkl'
    );
    const [pendingValues, setPendingValues] = useState<SimklFormValues>();

    const save = async (values: SimklFormValues, confirmed = false) => {
      try {
        await axios.post('/api/v1/settings/simkl', {
          ...values,
          clientId: values.clientId.trim(),
          ...(confirmed ? { confirmDisconnectLinkedAccounts: true } : {}),
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
      <Formik<SimklFormValues>
        initialValues={{
          enabled: data?.enabled ?? true,
          clientId: data?.clientId ?? '',
          actionsEnabled: data?.actionsEnabled ?? true,
          showCommunityRating: data?.showCommunityRating ?? true,
          posterCommunityRating: data?.posterCommunityRating ?? false,
        }}
        enableReinitialize
        onSubmit={async (values) => {
          if (
            data &&
            data.linkedAccountCount > 0 &&
            values.clientId.trim() !== data.clientId
          ) {
            setPendingValues(values);
            return;
          }
          await save(values);
        }}
      >
        {({ handleSubmit, isSubmitting, values }) => (
          <Modal
            ref={ref}
            title={intl.formatMessage(messages.configureSimkl)}
            loading={!data && !error}
            backgroundClickable={false}
            onCancel={onClose}
            okText={intl.formatMessage(
              isSubmitting ? globalMessages.saving : globalMessages.save
            )}
            okDisabled={isSubmitting || !data}
            onOk={() => handleSubmit()}
          >
            {error ? (
              <Alert
                type="error"
                title={intl.formatMessage(messages.loadFailed)}
              />
            ) : (
              <form onSubmit={handleSubmit}>
                <p className="description">
                  {intl.formatMessage(messages.description)}
                </p>
                <div className="form-row">
                  <label htmlFor="simklEnabled" className="checkbox-label">
                    {intl.formatMessage(messages.enabled)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.enabledTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field type="checkbox" id="simklEnabled" name="enabled" />
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="simklClientId" className="text-label">
                    {intl.formatMessage(messages.clientId)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.createAppTip, {
                        SimklAppLink: (msg: ReactNode) => (
                          <a
                            href="https://simkl.com/settings/developer/"
                            target="_blank"
                            rel="noreferrer"
                            className="text-white underline transition hover:text-gray-200"
                          >
                            {msg}
                          </a>
                        ),
                      })}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        id="simklClientId"
                        name="clientId"
                        type="text"
                        autoComplete="off"
                      />
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label
                    htmlFor="simklActionsEnabled"
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
                      id="simklActionsEnabled"
                      name="actionsEnabled"
                    />
                  </div>
                </div>
                <div className="form-row">
                  <label
                    htmlFor="simklShowCommunityRating"
                    className="checkbox-label"
                  >
                    {intl.formatMessage(messages.showCommunityRating)}
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="checkbox"
                      id="simklShowCommunityRating"
                      name="showCommunityRating"
                    />
                  </div>
                </div>
                <div className="form-row">
                  <label
                    htmlFor="simklPosterCommunityRating"
                    className={`checkbox-label ${
                      !values.showCommunityRating ? 'opacity-50' : ''
                    }`}
                  >
                    {intl.formatMessage(messages.posterCommunityRating)}
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="checkbox"
                      id="simklPosterCommunityRating"
                      name="posterCommunityRating"
                      disabled={!values.showCommunityRating}
                    />
                  </div>
                </div>
              </form>
            )}
            <Transition as={Fragment} show={!!pendingValues}>
              <Modal
                title={intl.formatMessage(messages.disconnectConfirmTitle)}
                okText={intl.formatMessage(messages.confirmReplace)}
                okButtonType="danger"
                onOk={async () => {
                  if (!pendingValues) return;
                  const confirmedValues = pendingValues;
                  setPendingValues(undefined);
                  await save(confirmedValues, true);
                }}
                onCancel={() => setPendingValues(undefined)}
              >
                {intl.formatMessage(messages.disconnectConfirmDescription, {
                  count: data?.linkedAccountCount ?? 0,
                })}
              </Modal>
            </Transition>
          </Modal>
        )}
      </Formik>
    );
  }
);

SettingsSimkl.displayName = 'SettingsSimkl';

export default SettingsSimkl;
