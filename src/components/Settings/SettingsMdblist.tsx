import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import Modal from '@app/components/Common/Modal';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import { TrashIcon } from '@heroicons/react/24/outline';
import type { RatingBadgeSettings } from '@server/constants/ratingBadges';
import { DEFAULT_RATING_BADGE_SETTINGS } from '@server/constants/ratingBadges';
import axios from 'axios';
import { Field, Formik } from 'formik';
import { Fragment, forwardRef, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate as globalMutate } from 'swr';

const messages = defineMessages('components.Settings.SettingsMdblist', {
  configureMdblist: 'Configure MDBList',
  mdblistSettingsDescription:
    'Configure an MDBList API key for aggregated rating badges and to pin public MDBList lists as custom Discover sliders.',
  apiKey: 'API Key',
  createAppTip:
    'Get a free API key at <MdbListLink>mdblist.com/preferences</MdbListLink>.',
  loadFailed: 'Unable to load MDBList settings.',
  ratingBadges: 'Rating Sources',
  ratingBadgesDescription:
    'Sources enabled here appear on detail pages and when a poster is focused/hovered.',
  posterIdle: 'Poster Ratings',
  posterIdleDescription:
    'Which enabled sources also show on posters before focus. Hover/focus shows all enabled sources above.',
  showTmdb: 'TMDB',
  showImdb: 'IMDb',
  showRt: 'Rotten Tomatoes (Critics)',
  showRtUser: 'Rotten Tomatoes (Audience)',
  showMetacritic: 'Metacritic',
  showTraktCommunity: 'Trakt Community',
  toastSettingsSuccess: 'MDBList settings saved successfully!',
  toastSettingsFailure: 'Something went wrong while saving MDBList settings.',
  toastClearSuccess: 'MDBList API key removed.',
  toastClearFailure: 'Something went wrong while removing the MDBList API key.',
  clearApiKey: 'Remove API Key',
  clearConfirmTitle: 'Remove MDBList API key?',
  clearConfirmDescription:
    'Rating badges that depend on MDBList will stop updating until you add a new key.',
  apiKeyTip:
    'The saved key is never shown. Leave blank to keep it, or paste a replacement',
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
  onClose: () => void;
};

const SettingsMdblist = forwardRef<HTMLDivElement, SettingsMdblistProps>(
  ({ onClose }, ref) => {
    const intl = useIntl();
    const { addToast } = useToasts();
    const { data, error, mutate } = useSWR<MdbListSettingsResponse>(
      '/api/v1/settings/mdblist'
    );
    const [clearModalOpen, setClearModalOpen] = useState(false);
    const [clearing, setClearing] = useState(false);

    const revalidate = () => {
      mutate();
      globalMutate('/api/v1/settings/public');
      globalMutate('/api/v1/settings/integrations/status');
    };

    const clearApiKey = async () => {
      setClearing(true);
      try {
        await axios.post('/api/v1/settings/mdblist', {
          ...DEFAULT_RATING_BADGE_SETTINGS,
          ...data,
          clearApiKey: true,
          apiKey: '',
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
        revalidate();
      }
    };

    return (
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
            onClose();
          } catch {
            addToast(intl.formatMessage(messages.toastSettingsFailure), {
              autoDismiss: true,
              appearance: 'error',
            });
          } finally {
            revalidate();
          }
        }}
      >
        {({ handleSubmit, isSubmitting, values }) => (
          <Modal
            ref={ref}
            title={intl.formatMessage(messages.configureMdblist)}
            loading={!data && !error}
            backgroundClickable={false}
            onCancel={onClose}
            okText={intl.formatMessage(
              isSubmitting ? globalMessages.saving : globalMessages.save
            )}
            okDisabled={isSubmitting || !data}
            onOk={() => handleSubmit()}
          >
            {error || !data ? (
              <Alert
                type="error"
                title={intl.formatMessage(messages.loadFailed)}
              />
            ) : (
              <form onSubmit={handleSubmit}>
                <p className="description">
                  {intl.formatMessage(messages.mdblistSettingsDescription)}{' '}
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
                <div className="form-row">
                  <label htmlFor="apiKey" className="text-label">
                    {intl.formatMessage(messages.apiKey)}
                    {data.configured && (
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
                    {data.configured && (
                      <Button
                        className="mt-3"
                        buttonType="danger"
                        buttonSize="sm"
                        type="button"
                        onClick={() => setClearModalOpen(true)}
                        disabled={clearing}
                      >
                        <TrashIcon />
                        <span>{intl.formatMessage(messages.clearApiKey)}</span>
                      </Button>
                    )}
                  </div>
                </div>

                <h4 className="mt-8 text-lg font-semibold text-gray-100">
                  {intl.formatMessage(messages.ratingBadges)}
                </h4>
                <p className="description">
                  {intl.formatMessage(messages.ratingBadgesDescription)}
                </p>
                {SOURCE_FIELDS.map(([showName, , label]) => (
                  <div className="form-row" key={showName}>
                    <label htmlFor={showName} className="checkbox-label">
                      {intl.formatMessage(label)}
                    </label>
                    <div className="form-input-area">
                      <Field type="checkbox" id={showName} name={showName} />
                    </div>
                  </div>
                ))}

                <h4 className="mt-8 text-lg font-semibold text-gray-100">
                  {intl.formatMessage(messages.posterIdle)}
                </h4>
                <p className="description">
                  {intl.formatMessage(messages.posterIdleDescription)}
                </p>
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
                        disabled={!values[showName]}
                      />
                    </div>
                  </div>
                ))}
              </form>
            )}
            <Transition as={Fragment} show={clearModalOpen}>
              <Modal
                okText={intl.formatMessage(messages.clearApiKey)}
                okButtonType="danger"
                okDisabled={clearing}
                onOk={clearApiKey}
                onCancel={() => setClearModalOpen(false)}
                title={intl.formatMessage(messages.clearConfirmTitle)}
              >
                {intl.formatMessage(messages.clearConfirmDescription)}
              </Modal>
            </Transition>
          </Modal>
        )}
      </Formik>
    );
  }
);

SettingsMdblist.displayName = 'SettingsMdblist';

export default SettingsMdblist;
