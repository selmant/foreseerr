import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import Modal from '@app/components/Common/Modal';
import useSettings from '@app/hooks/useSettings';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { EyeIcon, EyeSlashIcon, QrCodeIcon } from '@heroicons/react/24/outline';
import { MediaServerType } from '@server/constants/server';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import { useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import * as Yup from 'yup';

const messages = defineMessages(
  'components.UserProfile.UserSettings.LinkJellyfinModal',
  {
    title: 'Link {mediaServerName} Account',
    description:
      'Enter your {mediaServerName} credentials to link your account with {applicationName}.',
    username: 'Username',
    password: 'Password',
    usernameRequired: 'You must provide a username',
    passwordRequired: 'You must provide a password',
    saving: 'Adding…',
    save: 'Link',
    errorUnauthorized:
      'Unable to connect to {mediaServerName} using your credentials',
    errorExists: 'This account is already linked to a {applicationName} user',
    errorUnknown: 'An unknown error occurred',
    quickConnect: 'Use Quick Connect',
    quickConnectHint:
      'Already signed in to the Jellyfin app? Link with a code instead of entering your password.',
    showPassword: 'Show password',
    hidePassword: 'Hide password',
  }
);

interface LinkJellyfinModalProps {
  show: boolean;
  onClose: () => void;
  onSave: () => void;
  onSwitchToQuickConnect: () => void;
}

const LinkJellyfinModal = ({
  show,
  onClose,
  onSave,
  onSwitchToQuickConnect,
}: LinkJellyfinModalProps) => {
  const intl = useIntl();
  const settings = useSettings();
  const { user } = useUser();
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const passwordInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!show) setShowPassword(false);
  }, [show]);

  const JellyfinLoginSchema = Yup.object().shape({
    username: Yup.string().required(
      intl.formatMessage(messages.usernameRequired)
    ),
    password: Yup.string().required(
      intl.formatMessage(messages.passwordRequired)
    ),
  });

  const applicationName = settings.currentSettings.applicationTitle;
  const mediaServerName =
    settings.currentSettings.mediaServerType === MediaServerType.EMBY
      ? 'Emby'
      : 'Jellyfin';

  return (
    <Transition
      as="div"
      appear
      show={show}
      enter="transition ease-in-out duration-300 transform opacity-0"
      enterFrom="opacity-0"
      enterTo="opacity-100"
      leave="transition ease-in-out duration-300 transform opacity-100"
      leaveFrom="opacity-100"
      leaveTo="opacity-0"
    >
      <Formik
        initialValues={{
          username: '',
          password: '',
        }}
        validationSchema={JellyfinLoginSchema}
        onSubmit={async ({ username, password }) => {
          passwordInput.current?.focus();
          try {
            setError(null);
            await axios.post(
              `/api/v1/user/${user?.id}/settings/linked-accounts/jellyfin`,
              {
                username,
                password,
              }
            );
            onSave();
          } catch (e) {
            if (e?.response?.status === 401) {
              setError(
                intl.formatMessage(messages.errorUnauthorized, {
                  mediaServerName,
                })
              );
            } else if (e?.response?.status === 422) {
              setError(
                intl.formatMessage(messages.errorExists, { applicationName })
              );
            } else {
              setError(intl.formatMessage(messages.errorUnknown));
            }
          }
        }}
      >
        {({ errors, touched, handleSubmit, isSubmitting, isValid }) => {
          return (
            <Modal
              onCancel={() => {
                setError(null);
                onClose();
              }}
              okButtonType="primary"
              okButtonProps={{
                type: 'submit',
                form: 'link-jellyfin-account',
                'aria-busy': isSubmitting,
              }}
              okText={
                isSubmitting
                  ? intl.formatMessage(messages.saving)
                  : intl.formatMessage(messages.save)
              }
              okDisabled={isSubmitting || !isValid}
              onOk={(event) => {
                event?.preventDefault();
                if (!isSubmitting) handleSubmit();
              }}
              title={intl.formatMessage(messages.title, { mediaServerName })}
              dialogClass="sm:max-w-lg"
              stickyActions
            >
              <Form id="link-jellyfin-account">
                {intl.formatMessage(messages.description, {
                  mediaServerName,
                  applicationName,
                })}
                {error && (
                  <div className="mt-2">
                    <Alert type="error">{error}</Alert>
                  </div>
                )}
                <label htmlFor="username" className="text-label">
                  {intl.formatMessage(messages.username)}
                </label>
                <div className="mb-2 mt-1 sm:col-span-2 sm:mt-0">
                  <div className="flex rounded-md shadow-sm">
                    <Field
                      id="username"
                      name="username"
                      type="text"
                      autoComplete="username"
                      autoCapitalize="none"
                      spellCheck={false}
                      className="min-h-11 min-w-0"
                      readOnly={isSubmitting}
                      aria-invalid={Boolean(
                        errors.username && touched.username
                      )}
                      aria-describedby={
                        errors.username && touched.username
                          ? 'link-jellyfin-username-error'
                          : undefined
                      }
                      placeholder={intl.formatMessage(messages.username)}
                    />
                  </div>
                  {errors.username && touched.username && (
                    <div id="link-jellyfin-username-error" className="error">
                      {errors.username}
                    </div>
                  )}
                </div>
                <label htmlFor="password" className="text-label">
                  {intl.formatMessage(messages.password)}
                </label>
                <div className="mb-2 mt-1 sm:col-span-2 sm:mt-0">
                  <div className="flex rounded-md shadow-sm">
                    <Field
                      id="password"
                      name="password"
                      innerRef={passwordInput}
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="current-password"
                      className="rounded-l-only min-h-11 min-w-0"
                      readOnly={isSubmitting}
                      aria-invalid={Boolean(
                        errors.password && touched.password
                      )}
                      aria-describedby={
                        errors.password && touched.password
                          ? 'link-jellyfin-password-error'
                          : undefined
                      }
                      placeholder={intl.formatMessage(messages.password)}
                    />
                    <button
                      type="button"
                      className="input-action min-h-11 min-w-11"
                      aria-controls="password"
                      aria-label={intl.formatMessage(
                        showPassword
                          ? messages.hidePassword
                          : messages.showPassword
                      )}
                      onClick={() => setShowPassword((value) => !value)}
                    >
                      {showPassword ? <EyeSlashIcon /> : <EyeIcon />}
                    </button>
                  </div>
                  {errors.password && touched.password && (
                    <div id="link-jellyfin-password-error" className="error">
                      {errors.password}
                    </div>
                  )}
                </div>
                {settings.currentSettings.mediaServerType ===
                  MediaServerType.JELLYFIN && (
                  <div className="mt-4">
                    <Button
                      buttonType="ghost"
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => {
                        setError(null);
                        onSwitchToQuickConnect();
                      }}
                      className="min-h-11 w-full gap-2"
                    >
                      <QrCodeIcon />
                      <span>{intl.formatMessage(messages.quickConnect)}</span>
                    </Button>
                    <p className="mt-2 text-center text-sm leading-6 text-gray-400">
                      {intl.formatMessage(messages.quickConnectHint)}
                    </p>
                  </div>
                )}
              </Form>
            </Modal>
          );
        }}
      </Formik>
    </Transition>
  );
};

export default LinkJellyfinModal;
