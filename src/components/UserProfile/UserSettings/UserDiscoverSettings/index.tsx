import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import LinkButton from '@app/components/Common/LinkButton';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import MultiRangeSlider from '@app/components/Common/MultiRangeSlider';
import PageTitle from '@app/components/Common/PageTitle';
import {
  discoverRangeFilters,
  formatDiscoverRangeValue,
} from '@app/components/Discover/constants';
import LanguageSelector from '@app/components/LanguageSelector';
import { GenreSelector } from '@app/components/Selector';
import { useDiscoverFilterDraft } from '@app/components/UserProfile/UserSettings/UserDiscoverSettings/filterState';
import {
  clearHiddenUnmappedTitles,
  hiddenUnmappedCount,
} from '@app/hooks/useHiddenUnmappedTitles';
import useRouteQuery from '@app/hooks/useRouteQuery';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import {
  ArrowDownOnSquareIcon,
  EyeIcon,
  XCircleIcon,
} from '@heroicons/react/24/outline';
import Datepicker from '@seerr-team/react-tailwindcss-datepicker';
import type { DiscoverFilterDefaults } from '@server/lib/discover/filterDefaults';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages(
  'components.UserProfile.UserSettings.UserDiscoverSettings',
  {
    discover: 'Discover',
    discoversettings: 'Discover Filter Defaults',
    discoversettingsTip:
      'Choose your starting filters for Discover, then save your changes. Filters you adjust while browsing apply only to the current session.',
    hideWatched: 'Hide Watched',
    hideWatchedTip:
      'Uses Jellyfin and Trakt watch history when either is available.',
    hideUnmapped: 'Hide Unmapped Titles',
    hideUnmappedTip:
      'Hide titles from Trakt, AniList, MDBList, or Plex that could not be mapped to TMDB.',
    clearHiddenUnmapped: 'Show Hidden Unmapped Titles Again',
    hideCollected: 'Hide Collected',
    hideWatchlisted: 'Hide Watchlisted',
    traktOnlyTip: 'Applies to Trakt recommendations',
    releaseDate: 'Movie Release Date',
    firstAirDate: 'Series First Air Date',
    from: 'From',
    to: 'To',
    genresMovie: 'Movie Genres',
    genresTv: 'Series Genres',
    originalLanguage: 'Original Language',
    tmdbuserscore: 'TMDB User Score',
    tmdbuservotecount: 'TMDB User Vote Count',
    ratingText: 'Ratings between {minValue} and {maxValue}',
    voteCount: 'Number of votes between {minValue} and {maxValue}',
    externalRatings: 'External Ratings',
    externalRatingsTip:
      'Rating filters powered by MDBList. They only apply when MDBList is configured.',
    imdbScore: 'IMDb Rating',
    imdbScoreText: 'IMDb between {minValue} and {maxValue}',
    imdbVotes: 'IMDb Vote Count',
    imdbVotesText: 'IMDb votes between {minValue} and {maxValue}',
    rtCritics: 'RT Critics',
    rtCriticsText: 'RT critics between {minValue} and {maxValue}',
    rtAudience: 'RT Audience',
    rtAudienceText: 'RT audience between {minValue} and {maxValue}',
    metacritic: 'Metacritic',
    metacriticText: 'Metacritic between {minValue} and {maxValue}',
    traktScore: 'Trakt Community',
    traktScoreText: 'Trakt between {minValue} and {maxValue}',
    includeNoRating: 'Keep Titles Without External Ratings',
    toastSettingsSuccess: 'Discover defaults saved!',
    toastSettingsFailure:
      'Something went wrong while saving Discover defaults.',
    clearDefaults: 'Clear All Defaults',
    unsavedChanges: 'Unsaved changes',
    saved: 'Changes saved',
    discard: 'Discard',
    navigation: 'Discover preference sections',
    visibility: 'Visibility',
    titles: 'Dates, genres & language',
    ratings: 'TMDB ratings',
    linkedAccounts: 'Linked accounts',
    clearHint: 'Clearing defaults takes effect when you save.',
    ratingsUnavailable: 'External rating filters need MDBList',
    ratingsUnavailableHint:
      'You can save these preferences now. They will apply once an administrator configures MDBList.',
  }
);

const rangeMessageKeys = {
  imdbRating: { label: 'imdbScore', text: 'imdbScoreText' },
  imdbVotes: { label: 'imdbVotes', text: 'imdbVotesText' },
  rtCritics: { label: 'rtCritics', text: 'rtCriticsText' },
  rtAudience: { label: 'rtAudience', text: 'rtAudienceText' },
  metacritic: { label: 'metacritic', text: 'metacriticText' },
  traktRating: { label: 'traktScore', text: 'traktScoreText' },
} as const;

const UserDiscoverSettings = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const query = useRouteQuery();
  const { currentSettings } = useSettings();
  const { user } = useUser({ id: Number(query.userId) });
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<DiscoverFilterDefaults>(
    user ? `/api/v1/user/${user.id}/settings/discover` : null
  );
  const [isSaving, setIsSaving] = useState(false);
  const [hiddenCount, setHiddenCount] = useState(0);
  const {
    draft,
    movieGenres,
    tvGenres,
    setDraft,
    setMovieGenres,
    setTvGenres,
    setBool,
    setString,
    reset,
    discard,
    hasChanges,
  } = useDiscoverFilterDraft(data, user?.id);

  useEffect(() => {
    setHiddenCount(hiddenUnmappedCount(user?.id));
  }, [user?.id]);

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!user || error) {
    return <ErrorPage statusCode={500} />;
  }

  const save = async (payload: DiscoverFilterDefaults) => {
    setIsSaving(true);
    try {
      await axios.post(`/api/v1/user/${user.id}/settings/discover`, payload);
      await revalidate();
      addToast(intl.formatMessage(messages.toastSettingsSuccess), {
        appearance: 'success',
        autoDismiss: true,
      });
    } catch {
      addToast(intl.formatMessage(messages.toastSettingsFailure), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="pb-28">
      <PageTitle
        title={[
          intl.formatMessage(messages.discover),
          intl.formatMessage(globalMessages.usersettings),
          user.displayName,
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">
          {intl.formatMessage(messages.discoversettings)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.discoversettingsTip)}
        </p>
      </div>
      <nav
        aria-label={intl.formatMessage(messages.navigation)}
        className="mb-5 flex flex-wrap gap-2"
      >
        {[
          { id: 'discover-visibility', label: messages.visibility },
          { id: 'discover-titles', label: messages.titles },
          { id: 'discover-tmdb-ratings', label: messages.ratings },
          { id: 'discover-external-ratings', label: messages.externalRatings },
        ].map(({ id, label }) => (
          <a
            key={id}
            href={`#${id}`}
            className="flex min-h-11 items-center rounded-lg border border-gray-700 bg-gray-800/50 px-3 text-sm text-gray-300 hover:bg-gray-700 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            {intl.formatMessage(label)}
          </a>
        ))}
      </nav>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <LinkButton
          to={
            query.userId
              ? `/users/${user.id}/settings/linked-accounts`
              : '/profile/settings/linked-accounts'
          }
          className="min-h-11"
        >
          {intl.formatMessage(messages.linkedAccounts)}
        </LinkButton>
        <Button
          disabled={isSaving || Object.keys(draft).length === 0}
          className="min-h-11"
          onClick={reset}
        >
          <XCircleIcon />
          <span>{intl.formatMessage(messages.clearDefaults)}</span>
        </Button>
        <span className="text-xs text-gray-400">
          {intl.formatMessage(messages.clearHint)}
        </span>
      </div>
      <div id="discover-visibility" className="section scroll-mt-24">
        <h3 className="mb-4 text-lg font-semibold">
          {intl.formatMessage(messages.visibility)}
        </h3>
        <div className="form-row">
          <label htmlFor="ignoreWatched" className="checkbox-label">
            {intl.formatMessage(messages.hideWatched)}
            <span className="label-tip">
              {intl.formatMessage(messages.hideWatchedTip)}
            </span>
          </label>
          <div className="form-input-area">
            <input
              type="checkbox"
              id="ignoreWatched"
              checked={draft.ignoreWatched === true}
              onChange={(e) => {
                if (e.target.checked) {
                  setBool('ignoreWatched', true);
                } else {
                  setDraft((prev) => {
                    const next = { ...prev };
                    delete next.ignoreWatched;
                    return next;
                  });
                }
              }}
            />
          </div>
        </div>
        <div className="form-row">
          <label htmlFor="hideUnmapped" className="checkbox-label">
            {intl.formatMessage(messages.hideUnmapped)}
            <span className="label-tip">
              {intl.formatMessage(messages.hideUnmappedTip)}
            </span>
          </label>
          <div className="form-input-area">
            <input
              type="checkbox"
              id="hideUnmapped"
              checked={draft.hideUnmapped === true}
              onChange={(e) => {
                if (e.target.checked) {
                  setBool('hideUnmapped', true);
                } else {
                  setDraft((prev) => {
                    const next = { ...prev };
                    delete next.hideUnmapped;
                    return next;
                  });
                }
              }}
            />
            {hiddenCount > 0 && (
              <div className="mt-3">
                <Button
                  type="button"
                  buttonSize="sm"
                  onClick={() => {
                    clearHiddenUnmappedTitles(user.id);
                    setHiddenCount(0);
                  }}
                >
                  <EyeIcon />
                  <span>
                    {intl.formatMessage(messages.clearHiddenUnmapped)}
                  </span>
                </Button>
              </div>
            )}
          </div>
        </div>
        <div className="form-row">
          <label htmlFor="ignoreCollected" className="checkbox-label">
            {intl.formatMessage(messages.hideCollected)}
            <span className="label-tip">
              {intl.formatMessage(messages.traktOnlyTip)}
            </span>
          </label>
          <div className="form-input-area">
            <input
              type="checkbox"
              id="ignoreCollected"
              checked={draft.ignoreCollected === true}
              onChange={(e) => {
                if (e.target.checked) {
                  setBool('ignoreCollected', true);
                } else {
                  setDraft((prev) => {
                    const next = { ...prev };
                    delete next.ignoreCollected;
                    return next;
                  });
                }
              }}
            />
          </div>
        </div>
        <div className="form-row">
          <label htmlFor="ignoreWatchlisted" className="checkbox-label">
            {intl.formatMessage(messages.hideWatchlisted)}
            <span className="label-tip">
              {intl.formatMessage(messages.traktOnlyTip)}
            </span>
          </label>
          <div className="form-input-area">
            <input
              type="checkbox"
              id="ignoreWatchlisted"
              checked={draft.ignoreWatchlisted === true}
              onChange={(e) => {
                if (e.target.checked) {
                  setBool('ignoreWatchlisted', true);
                } else {
                  setDraft((prev) => {
                    const next = { ...prev };
                    delete next.ignoreWatchlisted;
                    return next;
                  });
                }
              }}
            />
          </div>
        </div>
      </div>
      <div id="discover-titles" className="section scroll-mt-24">
        <h3 className="mb-4 text-lg font-semibold">
          {intl.formatMessage(messages.titles)}
        </h3>
        <div className="form-row">
          <span className="text-label group-label">
            {intl.formatMessage(messages.releaseDate)}
          </span>
          <div className="form-input-area">
            <div className="relative z-40 flex max-w-xl space-x-2">
              <div className="flex flex-col">
                <label
                  htmlFor="discover-moviefrom"
                  className="mb-2 text-gray-400"
                >
                  <span className="sr-only">
                    {intl.formatMessage(messages.releaseDate)}{' '}
                  </span>
                  {intl.formatMessage(messages.from)}
                </label>
                <Datepicker
                  primaryColor="indigo"
                  value={{
                    startDate: draft.primaryReleaseDateGte ?? null,
                    endDate: draft.primaryReleaseDateGte ?? null,
                  }}
                  onChange={(value) =>
                    setString(
                      'primaryReleaseDateGte',
                      value?.startDate ? String(value.startDate) : undefined
                    )
                  }
                  inputName="moviefrom"
                  inputId="discover-moviefrom"
                  useRange={false}
                  asSingle
                  containerClassName="datepicker-wrapper"
                  inputClassName="pr-1 sm:pr-4 text-base leading-5"
                />
              </div>
              <div className="flex flex-col">
                <label
                  htmlFor="discover-movieto"
                  className="mb-2 text-gray-400"
                >
                  <span className="sr-only">
                    {intl.formatMessage(messages.releaseDate)}{' '}
                  </span>
                  {intl.formatMessage(messages.to)}
                </label>
                <Datepicker
                  primaryColor="indigo"
                  value={{
                    startDate: draft.primaryReleaseDateLte ?? null,
                    endDate: draft.primaryReleaseDateLte ?? null,
                  }}
                  onChange={(value) =>
                    setString(
                      'primaryReleaseDateLte',
                      value?.startDate ? String(value.startDate) : undefined
                    )
                  }
                  inputName="movieto"
                  inputId="discover-movieto"
                  useRange={false}
                  asSingle
                  containerClassName="datepicker-wrapper"
                  inputClassName="pr-1 sm:pr-4 text-base leading-5"
                />
              </div>
            </div>
          </div>
        </div>
        <div className="form-row">
          <span className="text-label group-label">
            {intl.formatMessage(messages.firstAirDate)}
          </span>
          <div className="form-input-area">
            <div className="relative z-40 flex max-w-xl space-x-2">
              <div className="flex flex-col">
                <label htmlFor="discover-tvfrom" className="mb-2 text-gray-400">
                  <span className="sr-only">
                    {intl.formatMessage(messages.firstAirDate)}{' '}
                  </span>
                  {intl.formatMessage(messages.from)}
                </label>
                <Datepicker
                  primaryColor="indigo"
                  value={{
                    startDate: draft.firstAirDateGte ?? null,
                    endDate: draft.firstAirDateGte ?? null,
                  }}
                  onChange={(value) =>
                    setString(
                      'firstAirDateGte',
                      value?.startDate ? String(value.startDate) : undefined
                    )
                  }
                  inputName="tvfrom"
                  inputId="discover-tvfrom"
                  useRange={false}
                  asSingle
                  containerClassName="datepicker-wrapper"
                  inputClassName="pr-1 sm:pr-4 text-base leading-5"
                />
              </div>
              <div className="flex flex-col">
                <label htmlFor="discover-tvto" className="mb-2 text-gray-400">
                  <span className="sr-only">
                    {intl.formatMessage(messages.firstAirDate)}{' '}
                  </span>
                  {intl.formatMessage(messages.to)}
                </label>
                <Datepicker
                  primaryColor="indigo"
                  value={{
                    startDate: draft.firstAirDateLte ?? null,
                    endDate: draft.firstAirDateLte ?? null,
                  }}
                  onChange={(value) =>
                    setString(
                      'firstAirDateLte',
                      value?.startDate ? String(value.startDate) : undefined
                    )
                  }
                  inputName="tvto"
                  inputId="discover-tvto"
                  useRange={false}
                  asSingle
                  containerClassName="datepicker-wrapper"
                  inputClassName="pr-1 sm:pr-4 text-base leading-5"
                />
              </div>
            </div>
          </div>
        </div>
        <div className="form-row">
          <span className="text-label group-label">
            {intl.formatMessage(messages.genresMovie)}
          </span>
          <div className="form-input-area">
            <div className="max-w-xl">
              <GenreSelector
                type="movie"
                label={intl.formatMessage(messages.genresMovie)}
                defaultValue={movieGenres || undefined}
                isMulti
                onChange={(value) => {
                  setMovieGenres(
                    value?.map((v) => String(v.value)).join(',') ?? ''
                  );
                }}
              />
            </div>
          </div>
        </div>
        <div className="form-row">
          <span className="text-label group-label">
            {intl.formatMessage(messages.genresTv)}
          </span>
          <div className="form-input-area">
            <div className="max-w-xl">
              <GenreSelector
                type="tv"
                label={intl.formatMessage(messages.genresTv)}
                defaultValue={tvGenres || undefined}
                isMulti
                onChange={(value) => {
                  setTvGenres(
                    value?.map((v) => String(v.value)).join(',') ?? ''
                  );
                }}
              />
            </div>
          </div>
        </div>
        <div className="form-row">
          <span className="text-label group-label">
            {intl.formatMessage(messages.originalLanguage)}
          </span>
          <div className="form-input-area">
            <div className="max-w-xl">
              <LanguageSelector
                value={draft.language}
                serverValue={currentSettings.originalLanguage}
                isUserSettings
                setFieldValue={(_key, value) => setString('language', value)}
              />
            </div>
          </div>
        </div>
      </div>
      <div id="discover-tmdb-ratings" className="section scroll-mt-24">
        <h3 className="mb-4 text-lg font-semibold">
          {intl.formatMessage(messages.ratings)}
        </h3>
        <div className="form-row">
          <span className="text-label group-label">
            {intl.formatMessage(messages.tmdbuserscore)}
          </span>
          <div className="form-input-area">
            <div className="relative z-0 max-w-xl">
              <MultiRangeSlider
                label={intl.formatMessage(messages.tmdbuserscore)}
                min={1}
                max={10}
                step={0.1}
                defaultMinValue={
                  draft.voteAverageGte
                    ? Number(draft.voteAverageGte)
                    : undefined
                }
                defaultMaxValue={
                  draft.voteAverageLte
                    ? Number(draft.voteAverageLte)
                    : undefined
                }
                onUpdateMin={(min) =>
                  setString(
                    'voteAverageGte',
                    min !== 1 && Number(draft.voteAverageLte) !== 10
                      ? min.toFixed(1)
                      : undefined
                  )
                }
                onUpdateMax={(max) =>
                  setString(
                    'voteAverageLte',
                    max !== 10 && Number(draft.voteAverageGte) !== 1
                      ? max.toFixed(1)
                      : undefined
                  )
                }
                subText={intl.formatMessage(messages.ratingText, {
                  minValue: draft.voteAverageGte ?? '1.0',
                  maxValue: draft.voteAverageLte ?? '10.0',
                })}
              />
            </div>
          </div>
        </div>
        <div className="form-row">
          <span className="text-label group-label">
            {intl.formatMessage(messages.tmdbuservotecount)}
          </span>
          <div className="form-input-area">
            <div className="relative z-0 max-w-xl">
              <MultiRangeSlider
                label={intl.formatMessage(messages.tmdbuservotecount)}
                min={0}
                max={1000}
                defaultMinValue={
                  draft.voteCountGte ? Number(draft.voteCountGte) : undefined
                }
                defaultMaxValue={
                  draft.voteCountLte ? Number(draft.voteCountLte) : undefined
                }
                onUpdateMin={(min) =>
                  setString(
                    'voteCountGte',
                    min !== 0 && Number(draft.voteCountLte) !== 1000
                      ? min.toString()
                      : undefined
                  )
                }
                onUpdateMax={(max) =>
                  setString(
                    'voteCountLte',
                    max !== 1000 && Number(draft.voteCountGte) !== 0
                      ? max.toString()
                      : undefined
                  )
                }
                subText={intl.formatMessage(messages.voteCount, {
                  minValue: draft.voteCountGte ?? 0,
                  maxValue: draft.voteCountLte ?? 1000,
                })}
              />
            </div>
          </div>
        </div>
      </div>

      <div id="discover-external-ratings" className="mb-6 scroll-mt-24">
        <h3 className="heading">
          {intl.formatMessage(messages.externalRatings)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.externalRatingsTip)}
        </p>
      </div>
      {!currentSettings.mdblistConfigured ? (
        <Alert
          type="info"
          title={intl.formatMessage(messages.ratingsUnavailable)}
        >
          {intl.formatMessage(messages.ratingsUnavailableHint)}
        </Alert>
      ) : null}
      <div className="section">
        {discoverRangeFilters.map((slider) => (
          <div className="form-row" key={slider.keyGte}>
            <span className="text-label group-label">
              {intl.formatMessage(messages[rangeMessageKeys[slider.id].label])}
            </span>
            <div className="form-input-area">
              <div className="relative z-0 max-w-xl">
                <MultiRangeSlider
                  label={intl.formatMessage(
                    messages[rangeMessageKeys[slider.id].label]
                  )}
                  min={slider.min}
                  max={slider.max}
                  step={'step' in slider ? slider.step : undefined}
                  defaultMinValue={
                    draft[slider.keyGte]
                      ? Number(draft[slider.keyGte])
                      : undefined
                  }
                  defaultMaxValue={
                    draft[slider.keyLte]
                      ? Number(draft[slider.keyLte])
                      : undefined
                  }
                  onUpdateMin={(min) => {
                    const atMin = min === slider.min;
                    const atMax = Number(draft[slider.keyLte]) === slider.max;
                    setString(
                      slider.keyGte,
                      !atMin && !atMax
                        ? formatDiscoverRangeValue(min, slider)
                        : undefined
                    );
                  }}
                  onUpdateMax={(max) => {
                    const atMax = max === slider.max;
                    const atMin = Number(draft[slider.keyGte]) === slider.min;
                    setString(
                      slider.keyLte,
                      !atMax && !atMin
                        ? formatDiscoverRangeValue(max, slider)
                        : undefined
                    );
                  }}
                  subText={intl.formatMessage(
                    messages[rangeMessageKeys[slider.id].text],
                    {
                      minValue: draft[slider.keyGte] ?? String(slider.min),
                      maxValue: draft[slider.keyLte] ?? String(slider.max),
                    }
                  )}
                />
              </div>
            </div>
          </div>
        ))}
        <div className="form-row">
          <label htmlFor="includeNoRating" className="checkbox-label">
            {intl.formatMessage(messages.includeNoRating)}
          </label>
          <div className="form-input-area">
            <input
              type="checkbox"
              id="includeNoRating"
              checked={draft.includeNoRating !== false}
              onChange={(e) => {
                if (e.target.checked) {
                  setDraft((prev) => {
                    const next = { ...prev };
                    delete next.includeNoRating;
                    return next;
                  });
                } else {
                  setBool('includeNoRating', false);
                }
              }}
            />
          </div>
        </div>
      </div>
      <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-30 border-t border-gray-700 bg-gray-900/95 px-4 py-3 shadow-lg backdrop-blur sm:bottom-0 lg:left-64">
        <div className="grid grid-cols-[1fr_auto_auto] items-center gap-2 sm:gap-3">
          <p
            role="status"
            className={`min-w-0 text-xs sm:text-sm ${hasChanges ? 'text-amber-200' : 'text-gray-400'}`}
          >
            {intl.formatMessage(
              hasChanges ? messages.unsavedChanges : messages.saved
            )}
          </p>
          <Button
            className="min-h-11"
            disabled={isSaving || !hasChanges}
            onClick={discard}
          >
            {intl.formatMessage(messages.discard)}
          </Button>
          <Button
            buttonType="primary"
            className="min-h-11"
            disabled={isSaving || !hasChanges}
            onClick={() => void save(draft)}
          >
            <ArrowDownOnSquareIcon className="hidden sm:block" />
            <span>
              {intl.formatMessage(
                isSaving ? globalMessages.saving : globalMessages.save
              )}
            </span>
          </Button>
        </div>
      </div>
    </div>
  );
};

export default UserDiscoverSettings;
