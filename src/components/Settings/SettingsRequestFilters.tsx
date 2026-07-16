import Badge from '@app/components/Common/Badge';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import useToasts from '@app/hooks/useToasts';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import type { RequestFiltersSettings } from '@server/lib/requestFilters/types';
import { DEFAULT_REQUEST_FILTERS } from '@server/lib/requestFilters/types';
import axios from 'axios';
import { Field, Formik } from 'formik';
import type { ChangeEvent } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Settings.SettingsRequestFilters', {
  discoverFilters: 'Discover Filters',
  discoverFiltersSettings: 'Discover quality filters',
  discoverFiltersDescription:
    'Hide low-quality titles from Discover browse (trending, popular, Trakt, sliders). Empty thresholds are off. Manual requests are never blocked by these filters.',
  enabled: 'Enable Discover filters',
  tmdbThreshold: 'Minimum TMDB rating (0–10)',
  tmdbMinVotes: 'Minimum TMDB votes',
  imdbThreshold: 'Minimum IMDb rating (0–10)',
  imdbMinVotes: 'Minimum IMDb votes',
  mdblistRatings: 'MDBList rating gates',
  mdblistRatingsTip:
    'Uses your MDBList API key. Leave blank to skip a source. All filled thresholds must pass.',
  rtCriticsThreshold: 'Minimum RT critics (0–100)',
  rtAudienceThreshold: 'Minimum RT audience (0–100)',
  metacriticThreshold: 'Minimum Metacritic (0–100)',
  traktThreshold: 'Minimum Trakt community (0–10)',
  includeNoRating: 'Keep titles with missing ratings',
  minReleaseYear: 'Minimum release year',
  excludedGenreIds: 'Excluded genre IDs',
  excludedGenreIdsTip:
    'Comma-separated TMDB genre IDs. Titles matching any listed genre are hidden from Discover.',
  animeRouting: 'Anime Sonarr routing',
  animeRoutingDescription:
    'Optional dedicated Sonarr servers when requesting anime. Leave empty to use the default Sonarr server with its anime quality profile and root folder.',
  animeSonarrServerId: 'Anime Sonarr server ID',
  animeSonarrServerId4k: 'Anime Sonarr 4K server ID',
  toastSettingsSuccess: 'Discover filter settings saved successfully!',
  toastSettingsFailure:
    'Something went wrong while saving discover filter settings.',
  enabledBadge: 'Filters enabled',
  disabledBadge: 'Filters disabled',
});

type SonarrServerSummary = {
  id: number;
  name: string;
  is4k: boolean;
  isDefault: boolean;
};

const emptyToNull = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
};

const SettingsRequestFilters = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, error, mutate } = useSWR<RequestFiltersSettings>(
    '/api/v1/settings/request-filters'
  );
  const { data: sonarrServers } = useSWR<SonarrServerSummary[]>(
    '/api/v1/service/sonarr'
  );

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  const initial = { ...DEFAULT_REQUEST_FILTERS, ...data };

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.discoverFilters),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">
          {intl.formatMessage(messages.discoverFiltersSettings)}
          <Badge
            badgeType={data?.enabled ? 'success' : 'warning'}
            className="ml-2"
          >
            {intl.formatMessage(
              data?.enabled ? messages.enabledBadge : messages.disabledBadge
            )}
          </Badge>
        </h3>
        <p className="description">
          {intl.formatMessage(messages.discoverFiltersDescription)}
        </p>
      </div>
      <Formik
        initialValues={{
          enabled: initial.enabled,
          tmdbThreshold:
            initial.tmdbThreshold != null ? String(initial.tmdbThreshold) : '',
          tmdbMinVotes:
            initial.tmdbMinVotes != null ? String(initial.tmdbMinVotes) : '',
          imdbThreshold:
            initial.imdbThreshold != null ? String(initial.imdbThreshold) : '',
          imdbMinVotes:
            initial.imdbMinVotes != null ? String(initial.imdbMinVotes) : '',
          rtCriticsThreshold:
            initial.rtCriticsThreshold != null
              ? String(initial.rtCriticsThreshold)
              : '',
          rtAudienceThreshold:
            initial.rtAudienceThreshold != null
              ? String(initial.rtAudienceThreshold)
              : '',
          metacriticThreshold:
            initial.metacriticThreshold != null
              ? String(initial.metacriticThreshold)
              : '',
          traktThreshold:
            initial.traktThreshold != null
              ? String(initial.traktThreshold)
              : '',
          includeNoRating: initial.includeNoRating,
          minReleaseYear:
            initial.minReleaseYear != null
              ? String(initial.minReleaseYear)
              : '',
          excludedGenreIds: initial.excludedGenreIds.join(', '),
          animeSonarrServerId:
            initial.animeSonarrServerId != null
              ? String(initial.animeSonarrServerId)
              : '',
          animeSonarrServerId4k:
            initial.animeSonarrServerId4k != null
              ? String(initial.animeSonarrServerId4k)
              : '',
        }}
        enableReinitialize
        onSubmit={async (values) => {
          try {
            await axios.post('/api/v1/settings/request-filters', {
              enabled: values.enabled,
              tmdbThreshold: emptyToNull(values.tmdbThreshold),
              tmdbMinVotes: emptyToNull(values.tmdbMinVotes),
              imdbThreshold: emptyToNull(values.imdbThreshold),
              imdbMinVotes: emptyToNull(values.imdbMinVotes),
              rtCriticsThreshold: emptyToNull(values.rtCriticsThreshold),
              rtAudienceThreshold: emptyToNull(values.rtAudienceThreshold),
              metacriticThreshold: emptyToNull(values.metacriticThreshold),
              traktThreshold: emptyToNull(values.traktThreshold),
              includeNoRating: values.includeNoRating,
              minReleaseYear: emptyToNull(values.minReleaseYear),
              excludedGenreIds: values.excludedGenreIds
                .split(',')
                .map((part) => part.trim())
                .filter(Boolean)
                .map((part) => Number(part))
                .filter((id) => Number.isFinite(id)),
              animeSonarrServerId: emptyToNull(values.animeSonarrServerId),
              animeSonarrServerId4k: emptyToNull(values.animeSonarrServerId4k),
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
        {({ handleSubmit, isSubmitting, setFieldValue }) => (
          <form className="section" onSubmit={handleSubmit}>
            <div className="form-row">
              <label htmlFor="enabled" className="checkbox-label">
                {intl.formatMessage(messages.enabled)}
              </label>
              <div className="form-input-area">
                <Field
                  type="checkbox"
                  id="enabled"
                  name="enabled"
                  className="form-checkbox"
                />
              </div>
            </div>

            <div className="form-row">
              <label htmlFor="tmdbThreshold" className="text-label">
                {intl.formatMessage(messages.tmdbThreshold)}
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field
                    id="tmdbThreshold"
                    name="tmdbThreshold"
                    type="number"
                    step="0.1"
                    min="0"
                    max="10"
                    className="rounded-md"
                    placeholder="off"
                  />
                </div>
              </div>
            </div>

            <div className="form-row">
              <label htmlFor="tmdbMinVotes" className="text-label">
                {intl.formatMessage(messages.tmdbMinVotes)}
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field
                    id="tmdbMinVotes"
                    name="tmdbMinVotes"
                    type="number"
                    min="0"
                    className="rounded-md"
                    placeholder="off"
                  />
                </div>
              </div>
            </div>

            <div className="form-row">
              <label htmlFor="imdbThreshold" className="text-label">
                {intl.formatMessage(messages.imdbThreshold)}
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field
                    id="imdbThreshold"
                    name="imdbThreshold"
                    type="number"
                    step="0.1"
                    min="0"
                    max="10"
                    className="rounded-md"
                    placeholder="off"
                  />
                </div>
              </div>
            </div>

            <div className="form-row">
              <label htmlFor="imdbMinVotes" className="text-label">
                {intl.formatMessage(messages.imdbMinVotes)}
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field
                    id="imdbMinVotes"
                    name="imdbMinVotes"
                    type="number"
                    min="0"
                    className="rounded-md"
                    placeholder="off"
                  />
                </div>
              </div>
            </div>

            <div className="mb-4 mt-8">
              <h4 className="text-lg font-semibold text-gray-100">
                {intl.formatMessage(messages.mdblistRatings)}
              </h4>
              <p className="description">
                {intl.formatMessage(messages.mdblistRatingsTip)}
              </p>
            </div>

            <div className="form-row">
              <label htmlFor="rtCriticsThreshold" className="text-label">
                {intl.formatMessage(messages.rtCriticsThreshold)}
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field
                    id="rtCriticsThreshold"
                    name="rtCriticsThreshold"
                    type="number"
                    min="0"
                    max="100"
                    className="rounded-md"
                    placeholder="off"
                  />
                </div>
              </div>
            </div>

            <div className="form-row">
              <label htmlFor="rtAudienceThreshold" className="text-label">
                {intl.formatMessage(messages.rtAudienceThreshold)}
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field
                    id="rtAudienceThreshold"
                    name="rtAudienceThreshold"
                    type="number"
                    min="0"
                    max="100"
                    className="rounded-md"
                    placeholder="off"
                  />
                </div>
              </div>
            </div>

            <div className="form-row">
              <label htmlFor="metacriticThreshold" className="text-label">
                {intl.formatMessage(messages.metacriticThreshold)}
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field
                    id="metacriticThreshold"
                    name="metacriticThreshold"
                    type="number"
                    min="0"
                    max="100"
                    className="rounded-md"
                    placeholder="off"
                  />
                </div>
              </div>
            </div>

            <div className="form-row">
              <label htmlFor="traktThreshold" className="text-label">
                {intl.formatMessage(messages.traktThreshold)}
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field
                    id="traktThreshold"
                    name="traktThreshold"
                    type="number"
                    step="0.1"
                    min="0"
                    max="10"
                    className="rounded-md"
                    placeholder="off"
                  />
                </div>
              </div>
            </div>

            <div className="form-row">
              <label htmlFor="includeNoRating" className="checkbox-label">
                {intl.formatMessage(messages.includeNoRating)}
              </label>
              <div className="form-input-area">
                <Field
                  type="checkbox"
                  id="includeNoRating"
                  name="includeNoRating"
                  className="form-checkbox"
                />
              </div>
            </div>

            <div className="form-row">
              <label htmlFor="minReleaseYear" className="text-label">
                {intl.formatMessage(messages.minReleaseYear)}
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field
                    id="minReleaseYear"
                    name="minReleaseYear"
                    type="number"
                    min="1900"
                    className="rounded-md"
                    placeholder="off"
                  />
                </div>
              </div>
            </div>

            <div className="form-row">
              <label htmlFor="excludedGenreIds" className="text-label">
                <span>{intl.formatMessage(messages.excludedGenreIds)}</span>
                <span className="label-tip">
                  {intl.formatMessage(messages.excludedGenreIdsTip)}
                </span>
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field
                    id="excludedGenreIds"
                    name="excludedGenreIds"
                    type="text"
                    className="rounded-md"
                    placeholder="27, 53"
                  />
                </div>
              </div>
            </div>

            <div className="mb-6 mt-10">
              <h3 className="heading">
                {intl.formatMessage(messages.animeRouting)}
              </h3>
              <p className="description">
                {intl.formatMessage(messages.animeRoutingDescription)}
              </p>
              {sonarrServers && sonarrServers.length > 0 && (
                <ul className="mt-2 list-inside list-disc text-sm text-gray-400">
                  {sonarrServers.map((server) => (
                    <li key={server.id}>
                      {server.id}: {server.name}
                      {server.is4k ? ' (4K)' : ''}
                      {server.isDefault ? ' — default' : ''}
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="form-row">
              <label htmlFor="animeSonarrServerId" className="text-label">
                {intl.formatMessage(messages.animeSonarrServerId)}
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field
                    as="select"
                    id="animeSonarrServerId"
                    name="animeSonarrServerId"
                    className="rounded-md"
                    onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                      setFieldValue('animeSonarrServerId', e.target.value)
                    }
                  >
                    <option value="">Default Sonarr</option>
                    {(sonarrServers ?? [])
                      .filter((server) => !server.is4k)
                      .map((server) => (
                        <option key={server.id} value={String(server.id)}>
                          {server.name} (#{server.id})
                        </option>
                      ))}
                  </Field>
                </div>
              </div>
            </div>

            <div className="form-row">
              <label htmlFor="animeSonarrServerId4k" className="text-label">
                {intl.formatMessage(messages.animeSonarrServerId4k)}
              </label>
              <div className="form-input-area">
                <div className="form-input-field">
                  <Field
                    as="select"
                    id="animeSonarrServerId4k"
                    name="animeSonarrServerId4k"
                    className="rounded-md"
                    onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                      setFieldValue('animeSonarrServerId4k', e.target.value)
                    }
                  >
                    <option value="">Default Sonarr 4K</option>
                    {(sonarrServers ?? [])
                      .filter((server) => server.is4k)
                      .map((server) => (
                        <option key={server.id} value={String(server.id)}>
                          {server.name} (#{server.id})
                        </option>
                      ))}
                  </Field>
                </div>
              </div>
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

export default SettingsRequestFilters;
