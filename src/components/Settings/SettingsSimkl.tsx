import Alert from '@app/components/Common/Alert';
import Modal from '@app/components/Common/Modal';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import axios from 'axios';
import { Field, Formik } from 'formik';
import { Fragment, forwardRef, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate as globalMutate } from 'swr';

const messages = defineMessages('components.Settings.SettingsSimkl', {
  configureSimkl: 'Configure Simkl',
  description:
    'Each user links their own Simkl account with a code, through Foreseerr’s Simkl app. Nothing needs to be registered on Simkl.',
  enabled: 'Enable Simkl',
  enabledTip:
    'Simkl Discover rows, linked accounts, and watched and rating actions',
  switchToBuiltin: 'Switch to Foreseerr’s Simkl App',
  switchToBuiltinTip:
    'This install still links through its own Simkl app (Client ID {clientId}). Foreseerr now ships its own, and Simkl retires AUTH V1 apps around April 2027. Linked users must link Simkl again after switching.',
  actionsEnabled: 'Allow Simkl Watched and Rating Actions',
  actionsEnabledTip:
    'Marking titles watched or rated in Foreseerr also updates the linked Simkl account',
  showCommunityRating: 'Show Community Ratings on Details',
  posterCommunityRating: 'Show Community Ratings on Posters',
  loadFailed: 'Unable to load Simkl settings.',
  toastSettingsSuccess: 'Simkl settings saved successfully!',
  toastSettingsFailure: 'Something went wrong while saving Simkl settings.',
  disconnectConfirmTitle: 'Switch to Foreseerr’s Simkl App?',
  disconnectConfirmDescription:
    'Switching apps will disconnect {count, plural, one {# linked Simkl account} other {# linked Simkl accounts}}. Those users must link Simkl again.',
  confirmReplace: 'Switch Apps',
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
  'enabled' | 'actionsEnabled' | 'showCommunityRating' | 'posterCommunityRating'
> & {
  /** Drop the install's legacy Client ID for Foreseerr's own app. */
  switchToBuiltin: boolean;
};

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

    const save = async (
      { switchToBuiltin, ...values }: SimklFormValues,
      confirmed = false
    ) => {
      try {
        await axios.post('/api/v1/settings/simkl', {
          ...values,
          ...(switchToBuiltin ? { clientId: '' } : {}),
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
          switchToBuiltin: false,
          actionsEnabled: data?.actionsEnabled ?? true,
          showCommunityRating: data?.showCommunityRating ?? true,
          posterCommunityRating: data?.posterCommunityRating ?? false,
        }}
        enableReinitialize
        onSubmit={async (values) => {
          if (data && data.linkedAccountCount > 0 && values.switchToBuiltin) {
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
                {data?.clientId ? (
                  <div className="form-row">
                    <label
                      htmlFor="simklSwitchToBuiltin"
                      className="checkbox-label"
                    >
                      {intl.formatMessage(messages.switchToBuiltin)}
                      <span className="label-tip">
                        {intl.formatMessage(messages.switchToBuiltinTip, {
                          clientId: `${data.clientId.slice(0, 8)}…`,
                        })}
                      </span>
                    </label>
                    <div className="form-input-area">
                      <Field
                        type="checkbox"
                        id="simklSwitchToBuiltin"
                        name="switchToBuiltin"
                      />
                    </div>
                  </div>
                ) : null}
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
