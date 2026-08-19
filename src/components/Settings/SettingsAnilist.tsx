import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import SettingsBadge from '@app/components/Settings/SettingsBadge';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import axios from 'axios';
import { Field, Formik } from 'formik';
import { Fragment, useState, type ReactNode } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate as globalMutate } from 'swr';
import * as Yup from 'yup';

const messages = defineMessages('components.Settings.SettingsAnilist', {
  anilist: 'AniList',
  description:
    'Create an AniList API application, then enter its credentials. Each user authorizes it separately with a PIN.',
  createAppTip:
    'Create an application at <AniListAppLink>anilist.co/settings/developer</AniListAppLink>. Set its Redirect URL to {redirectUrl}.',
  clientId: 'Client ID',
  clientSecret: 'Client Secret',
  validationClientId: 'You must provide a Client ID',
  validationClientSecret: 'You must provide a Client Secret',
  clientSecretTip:
    'A secret is saved. Leave this blank to keep it, or enter a replacement.',
  save: 'Save AniList credentials',
  actionsEnabled: 'Allow AniList watched and rating actions',
  actionsEnabledTip:
    'When enabled, marking anime watched or rated in Foreseerr also updates the linked AniList account.',
  anilistExperimentalTooltip:
    'Anime seasons and episodes do not always match TMDB one-to-one, so watches can land on the wrong AniList title or be skipped.',
  toastSettingsSuccess: 'AniList settings saved successfully.',
  toastSettingsFailure: 'Unable to save AniList settings.',
  toastActionsSuccess: 'AniList action settings updated.',
  toastActionsFailure: 'Unable to update AniList action settings.',
  configured: 'Configured',
  notConfigured: 'Not configured',
  clearCredentials: 'Remove credentials',
  clearConfirmTitle: 'Remove AniList credentials?',
  clearConfirmDescription:
    'This will disconnect {count, plural, one {# linked AniList account} other {# linked AniList accounts}}.',
  disconnectConfirmTitle: 'Replace AniList credentials?',
  disconnectConfirmDescription:
    'Replacing these credentials will disconnect {count, plural, one {# linked AniList account} other {# linked AniList accounts}}. Those users must authorize the application again.',
  confirmReplace: 'Replace credentials',
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
}

type SettingsAnilistProps = {
  onSave?: () => void;
};

const SettingsAnilist = ({ onSave }: SettingsAnilistProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<AnilistSettingsResponse>(
    '/api/v1/settings/anilist'
  );
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingValues, setPendingValues] = useState<AnilistFormValues | null>(
    null
  );
  const [clearing, setClearing] = useState(false);

  const save = async (
    values: AnilistFormValues,
    confirmDisconnectLinkedAccounts = false,
    clearCredentials = false
  ) => {
    await axios.post('/api/v1/settings/anilist', {
      clientId: values.clientId,
      clientSecret: values.clientSecret,
      actionsEnabled: data?.actionsEnabled !== false,
      confirmDisconnectLinkedAccounts,
      clearCredentials,
    });
    await mutate();
    await globalMutate('/api/v1/settings/public');
    await globalMutate('/api/v1/settings/integrations/status');
    addToast(intl.formatMessage(messages.toastSettingsSuccess), {
      appearance: 'success',
      autoDismiss: true,
    });
    onSave?.();
  };

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <Alert title={intl.formatMessage(messages.toastSettingsFailure)} />;
  }

  return (
    <>
      <Formik<AnilistFormValues>
        initialValues={{
          clientId: data.clientId,
          clientSecret: '',
        }}
        enableReinitialize
        validationSchema={Yup.object().shape({
          clientId: Yup.string().required(
            intl.formatMessage(messages.validationClientId)
          ),
          clientSecret: data.configured
            ? Yup.string()
            : Yup.string().required(
                intl.formatMessage(messages.validationClientSecret)
              ),
        })}
        onSubmit={async (values) => {
          try {
            const credentialsChanging =
              values.clientId !== data.clientId || Boolean(values.clientSecret);
            if (
              credentialsChanging &&
              (data.linkedAccountCount ?? 0) > 0 &&
              data.configured
            ) {
              setPendingValues(values);
              setConfirmOpen(true);
              return;
            }
            await save(values);
          } catch {
            addToast(intl.formatMessage(messages.toastSettingsFailure), {
              appearance: 'error',
              autoDismiss: true,
            });
          }
        }}
      >
        {({ handleSubmit, isSubmitting, isValid, values }) => (
          <form className="space-y-6" onSubmit={handleSubmit}>
            <div className="flex items-center gap-2">
              <h3 className="text-lg font-semibold text-white">
                {intl.formatMessage(messages.anilist)}
              </h3>
              <Badge badgeType={data.configured ? 'success' : 'warning'}>
                {intl.formatMessage(
                  data.configured ? messages.configured : messages.notConfigured
                )}
              </Badge>
            </div>
            <p className="text-sm text-gray-400">
              {intl.formatMessage(messages.description)}
            </p>
            <p className="text-sm text-gray-400">
              {intl.formatMessage(messages.createAppTip, {
                redirectUrl: data.redirectUrl,
                AniListAppLink: (msg: ReactNode) => (
                  <a
                    href="https://anilist.co/settings/developer"
                    target="_blank"
                    rel="noreferrer"
                    className="text-white underline"
                  >
                    {msg}
                  </a>
                ),
              })}
            </p>
            <div className="form-row">
              <label htmlFor="anilist-client-id" className="text-label">
                {intl.formatMessage(messages.clientId)}
              </label>
              <div className="form-input-area">
                <Field
                  id="anilist-client-id"
                  name="clientId"
                  type="text"
                  autoComplete="off"
                />
              </div>
            </div>
            <div className="form-row">
              <label htmlFor="anilist-client-secret" className="text-label">
                {intl.formatMessage(messages.clientSecret)}
              </label>
              <div className="form-input-area">
                <SensitiveInput
                  as="field"
                  id="anilist-client-secret"
                  name="clientSecret"
                  autoComplete="off"
                />
                {data.configured && (
                  <p className="mt-2 text-xs text-gray-400">
                    {intl.formatMessage(messages.clientSecretTip)}
                  </p>
                )}
              </div>
            </div>
            <div className="flex justify-end">
              <span className="inline-flex rounded-md shadow-sm">
                <Button
                  buttonType="primary"
                  type="submit"
                  disabled={isSubmitting || !isValid}
                >
                  <ArrowDownOnSquareIcon />
                  <span>
                    {isSubmitting
                      ? intl.formatMessage(globalMessages.saving)
                      : intl.formatMessage(messages.save)}
                  </span>
                </Button>
              </span>
            </div>
            <div className="flex items-start">
              <input
                id="anilist-actions-enabled"
                type="checkbox"
                className="rounded border-gray-500"
                checked={data.actionsEnabled}
                onChange={async (event) => {
                  try {
                    await axios.post('/api/v1/settings/anilist/actions', {
                      actionsEnabled: event.target.checked,
                    });
                    await mutate();
                    await globalMutate('/api/v1/settings/public');
                    addToast(intl.formatMessage(messages.toastActionsSuccess), {
                      appearance: 'success',
                      autoDismiss: true,
                    });
                  } catch {
                    addToast(intl.formatMessage(messages.toastActionsFailure), {
                      appearance: 'error',
                      autoDismiss: true,
                    });
                  }
                }}
              />
              <label htmlFor="anilist-actions-enabled" className="ml-2">
                <span className="flex items-center gap-2 text-sm font-medium text-gray-200">
                  {intl.formatMessage(messages.actionsEnabled)}
                  <SettingsBadge
                    badgeType="experimental"
                    tooltip={intl.formatMessage(
                      messages.anilistExperimentalTooltip
                    )}
                  />
                </span>
                <span className="text-xs text-gray-400">
                  {intl.formatMessage(messages.actionsEnabledTip)}
                </span>
              </label>
            </div>
            {data.configured && (
              <Button
                buttonType="danger"
                type="button"
                disabled={clearing}
                onClick={async () => {
                  setClearing(true);
                  try {
                    await save(values, true, true);
                  } catch {
                    addToast(
                      intl.formatMessage(messages.toastSettingsFailure),
                      {
                        appearance: 'error',
                        autoDismiss: true,
                      }
                    );
                  } finally {
                    setClearing(false);
                  }
                }}
              >
                {intl.formatMessage(messages.clearCredentials)}
              </Button>
            )}
          </form>
        )}
      </Formik>

      <Transition as={Fragment} show={confirmOpen}>
        <Modal
          title={intl.formatMessage(messages.disconnectConfirmTitle)}
          onCancel={() => {
            setConfirmOpen(false);
            setPendingValues(null);
          }}
          okButtonType="danger"
          okText={intl.formatMessage(messages.confirmReplace)}
          onOk={async () => {
            if (!pendingValues) {
              return;
            }
            try {
              await save(pendingValues, true);
              setConfirmOpen(false);
              setPendingValues(null);
            } catch {
              addToast(intl.formatMessage(messages.toastSettingsFailure), {
                appearance: 'error',
                autoDismiss: true,
              });
            }
          }}
        >
          {intl.formatMessage(messages.disconnectConfirmDescription, {
            count: data.linkedAccountCount ?? 0,
          })}
        </Modal>
      </Transition>
    </>
  );
};

export default SettingsAnilist;
