import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import Modal from '@app/components/Common/Modal';
import PageTitle from '@app/components/Common/PageTitle';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import type { RatingBadgeSettings } from '@server/constants/ratingBadges';
import { DEFAULT_RATING_BADGE_SETTINGS } from '@server/constants/ratingBadges';
import axios from 'axios';
import { Field, Formik } from 'formik';
import { Fragment, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate as globalMutate } from 'swr';

const messages = defineMessages('components.Settings.SettingsMdblist', {
  mdblist: 'MDBList',
  mdblistSettings: 'MDBList Settings',
  mdblistSettingsDescription:
    'Configure an MDBList API key to show aggregated IMDb, Rotten Tomatoes, Metacritic, and Trakt rating badges on title cards and media details.',
  apiKey: 'API Key',
  createAppTip:
    'Get a free API key at <MdbListLink>mdblist.com/preferences</MdbListLink>.',
  ratingBadges: 'Rating sources',
  ratingBadgesDescription:
    'Sources enabled here appear on detail pages and when a poster is focused/hovered.',
  posterIdle: 'Poster (idle)',
  posterIdleDescription:
    'Which enabled sources also show on posters before focus. Hover/focus shows all enabled sources above.',
  showTmdb: 'TMDB',
  showImdb: 'IMDb',
  showRt: 'Rotten Tomatoes (critics)',
  showRtUser: 'Rotten Tomatoes (audience)',
  showMetacritic: 'Metacritic',
  showTraktCommunity: 'Trakt community',
  toastSettingsSuccess: 'MDBList settings saved successfully!',
  toastSettingsFailure: 'Something went wrong while saving MDBList settings.',
  toastClearSuccess: 'MDBList API key removed.',
  toastClearFailure: 'Something went wrong while removing the MDBList API key.',
  configured: 'Configured',
  notConfigured: 'Not Configured',
  clearApiKey: 'Remove API key',
  clearConfirmTitle: 'Remove MDBList API key?',
  clearConfirmDescription:
    'Rating badges that depend on MDBList will stop updating until you add a new key.',
  apiKeyTip:
    'The saved key is never shown. Leave blank to keep the current key, or paste a new key to replace it.',
});

type MdbListSettingsResponse = {
  apiKey: string;
  configured: boolean;
} & RatingBadgeSettings;

const SOURCE_FIELDS = [
  ['showTmdb', 'posterTmdb', messages.showTmdb],
  ['showImdb', 'posterImdb', messages.showImdb],
  ['showRt', 'posterRt', messages.showRt],
  ['showRtUser', 'posterRtUser', messages.showRtUser],
  ['showMetacritic', 'posterMetacritic', messages.showMetacritic],
  ['showTraktCommunity', 'posterTraktCommunity', messages.showTraktCommunity],
] as const;

type SettingsMdblistProps = {
  onSave?: () => void;
};

const SettingsMdblist = ({ onSave }: SettingsMdblistProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<MdbListSettingsResponse>(
    '/api/v1/settings/mdblist'
  );
  const [clearModalOpen, setClearModalOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  const clearApiKey = async () => {
    setClearing(true);
    try {
      await axios.post('/api/v1/settings/mdblist', {
        clearApiKey: true,
        apiKey: '',
        showTmdb: data?.showTmdb ?? true,
        showImdb: data?.showImdb ?? true,
        showRt: data?.showRt ?? true,
        showRtUser: data?.showRtUser ?? true,
        showMetacritic: data?.showMetacritic ?? true,
        showTraktCommunity: data?.showTraktCommunity ?? true,
        posterTmdb: data?.posterTmdb ?? true,
        posterImdb: data?.posterImdb ?? true,
        posterRt: data?.posterRt ?? true,
        posterRtUser: data?.posterRtUser ?? false,
        posterMetacritic: data?.posterMetacritic ?? false,
        posterTraktCommunity: data?.posterTraktCommunity ?? false,
      });
      addToast(intl.formatMessage(messages.toastClearSuccess), {
        autoDismiss: true,
        appearance: 'success',
      });
    } catch {
      addToast(intl.formatMessage(messages.toastClearFailure), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setClearing(false);
      setClearModalOpen(false);
      mutate();
      globalMutate('/api/v1/settings/public');
      globalMutate('/api/v1/settings/integrations/status');
    }
  };

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.mdblist),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">
          {intl.formatMessage(messages.mdblistSettings)}
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
          {intl.formatMessage(messages.mdblistSettingsDescription)}
        </p>
        <p className="description mt-2">
          {intl.formatMessage(messages.createAppTip, {
            MdbListLink: (msg: React.ReactNode) => (
              <a
                href="https://mdblist.com/preferences/"
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
          ...DEFAULT_RATING_BADGE_SETTINGS,
          ...data,
          // Never seed the masked placeholder — reveal would only show asterisks.
          // Empty field: leave blank to keep the current key (server preserves).
          apiKey: '',
        }}
        enableReinitialize
        onSubmit={async (values) => {
          try {
            await axios.post('/api/v1/settings/mdblist', {
              apiKey: values.apiKey.trim(),
              showTmdb: values.showTmdb,
              showImdb: values.showImdb,
              showRt: values.showRt,
              showRtUser: values.showRtUser,
              showMetacritic: values.showMetacritic,
              showTraktCommunity: values.showTraktCommunity,
              posterTmdb: values.posterTmdb,
              posterImdb: values.posterImdb,
              posterRt: values.posterRt,
              posterRtUser: values.posterRtUser,
              posterMetacritic: values.posterMetacritic,
              posterTraktCommunity: values.posterTraktCommunity,
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
            mutate();
            globalMutate('/api/v1/settings/public');
            globalMutate('/api/v1/settings/integrations/status');
          }
        }}
      >
        {({ handleSubmit, isSubmitting, isValid, values }) => (
          <form className="section" onSubmit={handleSubmit}>
            <div className="form-row">
              <label htmlFor="apiKey" className="text-label">
                {intl.formatMessage(messages.apiKey)}
                {data?.configured && (
                  <span className="label-tip">
                    {intl.formatMessage(messages.apiKeyTip)}
                  </span>
                )}
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <SensitiveInput
                    as="field"
                    id="apiKey"
                    name="apiKey"
                    autoComplete="off"
                  />
                </div>
                {data?.configured && (
                  <div className="mt-3">
                    <Button
                      buttonType="danger"
                      type="button"
                      onClick={() => setClearModalOpen(true)}
                      disabled={clearing}
                    >
                      {intl.formatMessage(messages.clearApiKey)}
                    </Button>
                  </div>
                )}
              </div>
            </div>

            <div className="mb-6 mt-8">
              <h3 className="heading">
                {intl.formatMessage(messages.ratingBadges)}
              </h3>
              <p className="description">
                {intl.formatMessage(messages.ratingBadgesDescription)}
              </p>
            </div>

            {SOURCE_FIELDS.map(([showName, , label]) => (
              <div className="form-row" key={showName}>
                <label htmlFor={showName} className="checkbox-label">
                  {intl.formatMessage(label)}
                </label>
                <div className="form-input-area">
                  <Field
                    type="checkbox"
                    id={showName}
                    name={showName}
                    className="form-checkbox"
                  />
                </div>
              </div>
            ))}

            <div className="mb-6 mt-8">
              <h3 className="heading">
                {intl.formatMessage(messages.posterIdle)}
              </h3>
              <p className="description">
                {intl.formatMessage(messages.posterIdleDescription)}
              </p>
            </div>

            {SOURCE_FIELDS.map(([showName, posterName, label]) => (
              <div className="form-row" key={posterName}>
                <label
                  htmlFor={posterName}
                  className={`checkbox-label ${
                    !values[showName] ? 'opacity-50' : ''
                  }`}
                >
                  {intl.formatMessage(label)}
                </label>
                <div className="form-input-area">
                  <Field
                    type="checkbox"
                    id={posterName}
                    name={posterName}
                    className="form-checkbox"
                    disabled={!values[showName]}
                  />
                </div>
              </div>
            ))}

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
      <Transition
        as={Fragment}
        show={clearModalOpen}
        enter="transition-opacity ease-in-out duration-300"
        enterFrom="opacity-0"
        enterTo="opacity-100"
        leave="transition-opacity ease-in-out duration-300"
        leaveFrom="opacity-100"
        leaveTo="opacity-0"
      >
        <Modal
          okText={intl.formatMessage(messages.clearApiKey)}
          okButtonType="danger"
          onOk={clearApiKey}
          onCancel={() => setClearModalOpen(false)}
          title={intl.formatMessage(messages.clearConfirmTitle)}
        >
          {intl.formatMessage(messages.clearConfirmDescription)}
        </Modal>
      </Transition>
    </>
  );
};

export default SettingsMdblist;
