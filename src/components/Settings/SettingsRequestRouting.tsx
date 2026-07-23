import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import RequestProfileRouteFields from '@app/components/Settings/RequestProfileRouteFields';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import type {
  RequestProfileRouting,
  RequestRoutingSettings,
} from '@server/lib/requestFilters/types';
import { DEFAULT_REQUEST_ROUTING } from '@server/lib/requestFilters/types';
import axios from 'axios';
import { Formik } from 'formik';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Settings.SettingsRequestRouting', {
  requestRouting: 'Request Routing',
  requestRoutingDescription:
    'Optional Radarr/Sonarr server, quality profile, and root folder overrides for default and anime requests. Leave server empty to use the default instance for each quality tier.',
  movies: 'Movies',
  tvShows: 'TV shows',
  animeMovies: 'Anime movies',
  animeTv: 'Anime TV',
  toastSettingsSuccess: 'Request routing settings saved successfully!',
  toastSettingsFailure:
    'Something went wrong while saving request routing settings.',
});

type SonarrServerSummary = {
  id: number;
  name: string;
  is4k: boolean;
  isDefault: boolean;
};

type RadarrServerSummary = SonarrServerSummary;

const SettingsRequestRouting = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<RequestRoutingSettings>(
    '/api/v1/settings/request-routing'
  );
  const { data: sonarrServers } = useSWR<SonarrServerSummary[]>(
    '/api/v1/service/sonarr'
  );
  const { data: radarrServers } = useSWR<RadarrServerSummary[]>(
    '/api/v1/service/radarr'
  );

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  const initial = { ...DEFAULT_REQUEST_ROUTING, ...data };

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.requestRouting),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">
          {intl.formatMessage(messages.requestRouting)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.requestRoutingDescription)}
        </p>
      </div>
      <Formik
        initialValues={{
          profileRouting: initial.profileRouting,
        }}
        enableReinitialize
        onSubmit={async (values) => {
          try {
            await axios.post('/api/v1/settings/request-routing', {
              profileRouting: values.profileRouting,
            });
            addToast(intl.formatMessage(messages.toastSettingsSuccess), {
              appearance: 'success',
              autoDismiss: true,
            });
            mutate();
          } catch {
            addToast(intl.formatMessage(messages.toastSettingsFailure), {
              appearance: 'error',
              autoDismiss: true,
            });
          }
        }}
      >
        {({ handleSubmit, isSubmitting, values, setFieldValue }) => (
          <form className="section" onSubmit={handleSubmit}>
            <div className="grid gap-4 md:grid-cols-2">
              {(radarrServers?.length ?? 0) > 0 && (
                <RequestProfileRouteFields
                  arrKind="radarr"
                  title={intl.formatMessage(messages.movies)}
                  servers={radarrServers ?? []}
                  value={values.profileRouting.defaultMovie}
                  onChange={(route) =>
                    setFieldValue('profileRouting', {
                      ...values.profileRouting,
                      defaultMovie: route,
                    } satisfies RequestProfileRouting)
                  }
                />
              )}
              {(sonarrServers?.length ?? 0) > 0 && (
                <RequestProfileRouteFields
                  arrKind="sonarr"
                  title={intl.formatMessage(messages.tvShows)}
                  servers={sonarrServers ?? []}
                  value={values.profileRouting.defaultTv}
                  showLanguageProfile
                  onChange={(route) =>
                    setFieldValue('profileRouting', {
                      ...values.profileRouting,
                      defaultTv: route,
                    } satisfies RequestProfileRouting)
                  }
                />
              )}
              {(radarrServers?.length ?? 0) > 0 && (
                <RequestProfileRouteFields
                  arrKind="radarr"
                  title={intl.formatMessage(messages.animeMovies)}
                  servers={radarrServers ?? []}
                  value={values.profileRouting.animeMovie}
                  onChange={(route) =>
                    setFieldValue('profileRouting', {
                      ...values.profileRouting,
                      animeMovie: route,
                    } satisfies RequestProfileRouting)
                  }
                />
              )}
              {(sonarrServers?.length ?? 0) > 0 && (
                <RequestProfileRouteFields
                  arrKind="sonarr"
                  title={intl.formatMessage(messages.animeTv)}
                  servers={sonarrServers ?? []}
                  value={values.profileRouting.animeTv}
                  showLanguageProfile
                  onChange={(route) =>
                    setFieldValue('profileRouting', {
                      ...values.profileRouting,
                      animeTv: route,
                    } satisfies RequestProfileRouting)
                  }
                />
              )}
            </div>

            <div className="actions">
              <div className="flex justify-end">
                <span className="ml-3 inline-flex rounded-md shadow-sm">
                  <button
                    type="submit"
                    className="btn btn-primary"
                    disabled={isSubmitting}
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

export default SettingsRequestRouting;
