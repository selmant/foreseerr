import Button from '@app/components/Common/Button';
import MultiRangeSlider from '@app/components/Common/MultiRangeSlider';
import SlideOver from '@app/components/Common/SlideOver';
import type { FilterOptions } from '@app/components/Discover/constants';
import {
  countActiveFilters,
  discoverRangeFilters,
} from '@app/components/Discover/constants';
import {
  areDiscoverDefaultsCleared,
  markDiscoverDefaultsCleared,
} from '@app/components/Discover/mergeFilterDefaults';
import LanguageSelector from '@app/components/LanguageSelector';
import {
  CompanySelector,
  GenreSelector,
  KeywordSelector,
  StatusSelector,
  USCertificationSelector,
  WatchProviderSelector,
} from '@app/components/Selector';
import { useDiscoverFilterDefaults } from '@app/hooks/useDiscoverFilterDefaults';
import useSettings from '@app/hooks/useSettings';
import {
  useBatchUpdateQueryParams,
  useUpdateQueryParams,
} from '@app/hooks/useUpdateQueryParams';
import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { XCircleIcon } from '@heroicons/react/24/outline';
import Datepicker from '@seerr-team/react-tailwindcss-datepicker';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.FilterSlideover', {
  filters: 'Filters',
  activefilters:
    '{count, plural, one {# Active Filter} other {# Active Filters}}',
  releaseDate: 'Release Date',
  firstAirDate: 'First Air Date',
  from: 'From',
  to: 'To',
  studio: 'Studio',
  genres: 'Genres',
  keywords: 'Keywords',
  excludeKeywords: 'Exclude Keywords',
  originalLanguage: 'Original Language',
  runtimeText: '{minValue}-{maxValue} minute runtime',
  ratingText: 'Ratings between {minValue} and {maxValue}',
  clearfilters: 'Clear Active Filters',
  tmdbuserscore: 'TMDB User Score',
  tmdbuservotecount: 'TMDB User Vote Count',
  runtime: 'Runtime',
  streamingservices: 'Streaming Services',
  voteCount: 'Number of votes between {minValue} and {maxValue}',
  status: 'Status',
  certification: 'Content Rating',
  hideWatched: 'Hide watched',
  hideWatchedTip:
    'Uses Jellyfin and Trakt watch history when either is available.',
  hideCollected: 'Hide collected',
  hideWatchlisted: 'Hide watchlisted',
  hideUnmapped: 'Hide unmapped titles',
  hideUnmappedTip:
    'Hide titles from Trakt, AniList, MDBList, or Plex that could not be mapped to TMDB.',
  traktOptions: 'Trakt',
  watchedOptions: 'Watched',
  externalRatings: 'External ratings (MDBList)',
  externalRatingsTip:
    'Requires an MDBList API key in Settings. Full-range sliders are off.',
  imdbScore: 'IMDb rating',
  imdbScoreText: 'IMDb between {minValue} and {maxValue}',
  imdbVotes: 'IMDb vote count',
  imdbVotesText: 'IMDb votes between {minValue} and {maxValue}',
  rtCritics: 'RT critics',
  rtCriticsText: 'RT critics between {minValue} and {maxValue}',
  rtAudience: 'RT audience',
  rtAudienceText: 'RT audience between {minValue} and {maxValue}',
  metacritic: 'Metacritic',
  metacriticText: 'Metacritic between {minValue} and {maxValue}',
  traktScore: 'Trakt community',
  traktScoreText: 'Trakt between {minValue} and {maxValue}',
  includeNoRating: 'Keep titles with missing external ratings',
});

type FilterCapability =
  | 'studio'
  | 'keywords'
  | 'certification'
  | 'watchProviders';

export type FilterCapabilities = ReadonlySet<FilterCapability>;

/** Filters available on TMDB's native Discover endpoints. */
export const discoverFilterCapabilities: FilterCapabilities = new Set([
  'studio',
  'keywords',
  'certification',
  'watchProviders',
]);

/** Filters that can be applied after fetching a third-party browse list. */
export const browseFilterCapabilities: FilterCapabilities = new Set();

type FilterSlideoverProps = {
  show: boolean;
  onClose: () => void;
  type: 'movie' | 'tv';
  /** Genre catalog. Mixed lists should pass `all` so movie and TV names both appear. */
  genreType?: 'movie' | 'tv' | 'all';
  currentFilters: FilterOptions;
  /** Opt-in endpoint-specific filters; shared filters are always shown. */
  capabilities?: FilterCapabilities;
  showHideWatched?: boolean;
  showHideUnmapped?: boolean;
  showTraktRecommendationFilters?: boolean;
};

const FilterSlideover = ({
  show,
  onClose,
  type,
  genreType,
  currentFilters,
  capabilities = discoverFilterCapabilities,
  showHideWatched = false,
  showHideUnmapped = false,
  showTraktRecommendationFilters = false,
}: FilterSlideoverProps) => {
  const intl = useIntl();
  const { currentSettings } = useSettings();
  const { user } = useUser();
  const updateQueryParams = useUpdateQueryParams({});
  const batchUpdateQueryParams = useBatchUpdateQueryParams({});
  const { data: traktStatus } = useSWR<{
    connected: boolean;
  }>(
    showTraktRecommendationFilters && currentSettings.traktConfigured && user
      ? `/api/v1/user/${user.id}/settings/linked-accounts/trakt`
      : null
  );
  const { data: discoverDefaults } = useDiscoverFilterDefaults();
  const supports = (capability: FilterCapability) =>
    capabilities.has(capability);
  const hasExternalRatingFilters = discoverRangeFilters.length > 0;

  const dateGte =
    type === 'movie' ? 'primaryReleaseDateGte' : 'firstAirDateGte';
  const dateLte =
    type === 'movie' ? 'primaryReleaseDateLte' : 'firstAirDateLte';

  const defaultsActive = !areDiscoverDefaultsCleared(user?.id);
  const ignoreWatched =
    currentFilters.ignoreWatched === 'true' ||
    (currentFilters.ignoreWatched !== 'false' &&
      defaultsActive &&
      discoverDefaults?.ignoreWatched === true);
  const ignoreCollected =
    currentFilters.ignoreCollected === 'true' ||
    (currentFilters.ignoreCollected !== 'false' &&
      defaultsActive &&
      discoverDefaults?.ignoreCollected === true);
  const ignoreWatchlisted =
    currentFilters.ignoreWatchlisted === 'true' ||
    (currentFilters.ignoreWatchlisted !== 'false' &&
      defaultsActive &&
      discoverDefaults?.ignoreWatchlisted === true);
  const hideUnmapped =
    currentFilters.hideUnmapped === 'true' ||
    (currentFilters.hideUnmapped !== 'false' &&
      defaultsActive &&
      discoverDefaults?.hideUnmapped === true);

  const activeCount =
    countActiveFilters(currentFilters) +
    (showHideWatched &&
    (currentFilters.ignoreWatched === 'true' ||
      currentFilters.ignoreWatched === 'false')
      ? 1
      : 0) +
    (showHideUnmapped &&
    (currentFilters.hideUnmapped === 'true' ||
      currentFilters.hideUnmapped === 'false')
      ? 1
      : 0) +
    (showTraktRecommendationFilters && ignoreCollected ? 1 : 0) +
    (showTraktRecommendationFilters && ignoreWatchlisted ? 1 : 0);

  return (
    <SlideOver
      show={show}
      title={intl.formatMessage(messages.filters)}
      subText={intl.formatMessage(messages.activefilters, {
        count: activeCount,
      })}
      onClose={() => onClose()}
    >
      <div className="flex flex-col space-y-4">
        {showHideWatched && (
          <div>
            <div className="mb-2 text-lg font-semibold">
              {intl.formatMessage(messages.watchedOptions)}
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-200">
              <input
                type="checkbox"
                className="rounded border-gray-500 bg-gray-800 text-indigo-500"
                checked={ignoreWatched}
                onChange={(e) =>
                  updateQueryParams(
                    'ignoreWatched',
                    e.target.checked ? 'true' : 'false'
                  )
                }
              />
              {intl.formatMessage(messages.hideWatched)}
            </label>
            <p className="mt-1 text-xs text-gray-400">
              {intl.formatMessage(messages.hideWatchedTip)}
            </p>
          </div>
        )}
        {showHideUnmapped && (
          <div>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-200">
              <input
                type="checkbox"
                className="rounded border-gray-500 bg-gray-800 text-indigo-500"
                checked={hideUnmapped}
                onChange={(e) =>
                  updateQueryParams(
                    'hideUnmapped',
                    e.target.checked ? 'true' : 'false'
                  )
                }
              />
              {intl.formatMessage(messages.hideUnmapped)}
            </label>
            <p className="mt-1 text-xs text-gray-400">
              {intl.formatMessage(messages.hideUnmappedTip)}
            </p>
          </div>
        )}
        {showTraktRecommendationFilters && traktStatus?.connected && (
          <div>
            <div className="mb-2 text-lg font-semibold">
              {intl.formatMessage(messages.traktOptions)}
            </div>
            <div className="flex flex-col gap-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-200">
                <input
                  type="checkbox"
                  className="rounded border-gray-500 bg-gray-800 text-indigo-500"
                  checked={ignoreCollected}
                  onChange={(e) =>
                    updateQueryParams(
                      'ignoreCollected',
                      e.target.checked ? 'true' : 'false'
                    )
                  }
                />
                {intl.formatMessage(messages.hideCollected)}
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-200">
                <input
                  type="checkbox"
                  className="rounded border-gray-500 bg-gray-800 text-indigo-500"
                  checked={ignoreWatchlisted}
                  onChange={(e) =>
                    updateQueryParams(
                      'ignoreWatchlisted',
                      e.target.checked ? 'true' : 'false'
                    )
                  }
                />
                {intl.formatMessage(messages.hideWatchlisted)}
              </label>
            </div>
          </div>
        )}
        <div>
          <div className="mb-2 text-lg font-semibold">
            {intl.formatMessage(
              type === 'movie' ? messages.releaseDate : messages.firstAirDate
            )}
          </div>
          <div className="relative z-40 flex space-x-2">
            <div className="flex flex-col">
              <div className="mb-2">{intl.formatMessage(messages.from)}</div>
              <Datepicker
                primaryColor="indigo"
                value={{
                  startDate: currentFilters[dateGte] ?? null,
                  endDate: currentFilters[dateGte] ?? null,
                }}
                onChange={(value) => {
                  updateQueryParams(
                    dateGte,
                    value?.startDate ? (value.startDate as string) : undefined
                  );
                }}
                inputName="fromdate"
                useRange={false}
                asSingle
                containerClassName="datepicker-wrapper"
                inputClassName="pr-1 sm:pr-4 text-base leading-5"
              />
            </div>
            <div className="flex flex-col">
              <div className="mb-2">{intl.formatMessage(messages.to)}</div>
              <Datepicker
                primaryColor="indigo"
                value={{
                  startDate: currentFilters[dateLte] ?? null,
                  endDate: currentFilters[dateLte] ?? null,
                }}
                onChange={(value) => {
                  updateQueryParams(
                    dateLte,
                    value?.startDate ? (value.startDate as string) : undefined
                  );
                }}
                inputName="todate"
                useRange={false}
                asSingle
                containerClassName="datepicker-wrapper"
                inputClassName="pr-1 sm:pr-4 text-base leading-5"
              />
            </div>
          </div>
        </div>
        {type === 'movie' && supports('studio') && (
          <>
            <span className="text-lg font-semibold">
              {intl.formatMessage(messages.studio)}
            </span>
            <CompanySelector
              defaultValue={currentFilters.studio}
              onChange={(value) => {
                updateQueryParams('studio', value?.value.toString());
              }}
            />
          </>
        )}
        <span className="text-lg font-semibold">
          {intl.formatMessage(messages.genres)}
        </span>
        <GenreSelector
          type={genreType ?? type}
          defaultValue={currentFilters.genre}
          isMulti
          onChange={(value) => {
            updateQueryParams('genre', value?.map((v) => v.value).join(','));
          }}
        />
        {type === 'tv' && (
          <>
            <span className="text-lg font-semibold">
              {intl.formatMessage(messages.status)}
            </span>
            <StatusSelector
              defaultValue={currentFilters.status}
              isMulti
              onChange={(value) => {
                updateQueryParams(
                  'status',
                  value?.map((v) => v.value).join('|')
                );
              }}
            />
          </>
        )}
        {supports('keywords') && (
          <>
            <span className="text-lg font-semibold">
              {intl.formatMessage(messages.keywords)}
            </span>
            <KeywordSelector
              defaultValue={currentFilters.keywords}
              isMulti
              onChange={(value) => {
                updateQueryParams(
                  'keywords',
                  value?.map((v) => v.value).join(',')
                );
              }}
            />
            <span className="text-lg font-semibold">
              {intl.formatMessage(messages.excludeKeywords)}
            </span>
            <KeywordSelector
              defaultValue={currentFilters.excludeKeywords}
              isMulti
              onChange={(value) => {
                updateQueryParams(
                  'excludeKeywords',
                  value?.map((v) => v.value).join(',')
                );
              }}
            />
          </>
        )}
        <span className="text-lg font-semibold">
          {intl.formatMessage(messages.originalLanguage)}
        </span>
        <LanguageSelector
          value={currentFilters.language}
          serverValue={currentSettings.originalLanguage}
          isUserSettings
          setFieldValue={(_key, value) => {
            updateQueryParams('language', value);
          }}
        />
        {supports('certification') && (
          <>
            <span className="text-lg font-semibold">
              {intl.formatMessage(messages.certification)}
            </span>
            <USCertificationSelector
              type={type}
              certification={currentFilters.certification}
              onChange={(params) => {
                batchUpdateQueryParams(params);
              }}
            />
          </>
        )}
        <>
          <span className="text-lg font-semibold">
            {intl.formatMessage(messages.runtime)}
          </span>
          <div className="relative z-0">
            <MultiRangeSlider
              min={0}
              max={400}
              onUpdateMin={(min) => {
                updateQueryParams(
                  'withRuntimeGte',
                  min !== 0 && Number(currentFilters.withRuntimeLte) !== 400
                    ? min.toString()
                    : undefined
                );
              }}
              onUpdateMax={(max) => {
                updateQueryParams(
                  'withRuntimeLte',
                  max !== 400 && Number(currentFilters.withRuntimeGte) !== 0
                    ? max.toString()
                    : undefined
                );
              }}
              defaultMaxValue={
                currentFilters.withRuntimeLte
                  ? Number(currentFilters.withRuntimeLte)
                  : undefined
              }
              defaultMinValue={
                currentFilters.withRuntimeGte
                  ? Number(currentFilters.withRuntimeGte)
                  : undefined
              }
              subText={intl.formatMessage(messages.runtimeText, {
                minValue: currentFilters.withRuntimeGte ?? 0,
                maxValue: currentFilters.withRuntimeLte ?? 400,
              })}
            />
          </div>
        </>
        <span className="text-lg font-semibold">
          {intl.formatMessage(messages.tmdbuserscore)}
        </span>
        <div className="relative z-0">
          <MultiRangeSlider
            min={1}
            max={10}
            step={0.1}
            defaultMaxValue={
              currentFilters.voteAverageLte
                ? Number(currentFilters.voteAverageLte)
                : undefined
            }
            defaultMinValue={
              currentFilters.voteAverageGte
                ? Number(currentFilters.voteAverageGte)
                : undefined
            }
            onUpdateMin={(min) => {
              updateQueryParams(
                'voteAverageGte',
                min !== 1 && Number(currentFilters.voteAverageLte) !== 10
                  ? min.toFixed(1)
                  : undefined
              );
            }}
            onUpdateMax={(max) => {
              updateQueryParams(
                'voteAverageLte',
                max !== 10 && Number(currentFilters.voteAverageGte) !== 1
                  ? max.toFixed(1)
                  : undefined
              );
            }}
            subText={intl.formatMessage(messages.ratingText, {
              minValue: currentFilters.voteAverageGte ?? '1.0',
              maxValue: currentFilters.voteAverageLte ?? '10.0',
            })}
          />
        </div>
        <span className="text-lg font-semibold">
          {intl.formatMessage(messages.tmdbuservotecount)}
        </span>
        <div className="relative z-0">
          <MultiRangeSlider
            min={0}
            max={1000}
            defaultMaxValue={
              currentFilters.voteCountLte
                ? Number(currentFilters.voteCountLte)
                : undefined
            }
            defaultMinValue={
              currentFilters.voteCountGte
                ? Number(currentFilters.voteCountGte)
                : undefined
            }
            onUpdateMin={(min) => {
              updateQueryParams(
                'voteCountGte',
                min !== 0 && Number(currentFilters.voteCountLte) !== 1000
                  ? min.toString()
                  : undefined
              );
            }}
            onUpdateMax={(max) => {
              updateQueryParams(
                'voteCountLte',
                max !== 1000 && Number(currentFilters.voteCountGte) !== 0
                  ? max.toString()
                  : undefined
              );
            }}
            subText={intl.formatMessage(messages.voteCount, {
              minValue: currentFilters.voteCountGte ?? 0,
              maxValue: currentFilters.voteCountLte ?? 1000,
            })}
          />
        </div>
        {hasExternalRatingFilters && (
          <div>
            <div className="mb-1 text-lg font-semibold">
              {intl.formatMessage(messages.externalRatings)}
            </div>
            {currentSettings.mdblistConfigured && (
              <p className="mb-3 text-sm text-gray-400">
                {intl.formatMessage(messages.externalRatingsTip)}
              </p>
            )}
          </div>
        )}
        <span className="text-lg font-semibold">
          {intl.formatMessage(messages.imdbScore)}
        </span>
        <div className="relative z-0">
          <MultiRangeSlider
            min={1}
            max={10}
            step={0.1}
            defaultMinValue={
              currentFilters.imdbRatingGte
                ? Number(currentFilters.imdbRatingGte)
                : undefined
            }
            defaultMaxValue={
              currentFilters.imdbRatingLte
                ? Number(currentFilters.imdbRatingLte)
                : undefined
            }
            onUpdateMin={(min) => {
              updateQueryParams(
                'imdbRatingGte',
                min !== 1 && Number(currentFilters.imdbRatingLte) !== 10
                  ? min.toFixed(1)
                  : undefined
              );
            }}
            onUpdateMax={(max) => {
              updateQueryParams(
                'imdbRatingLte',
                max !== 10 && Number(currentFilters.imdbRatingGte) !== 1
                  ? max.toFixed(1)
                  : undefined
              );
            }}
            subText={intl.formatMessage(messages.imdbScoreText, {
              minValue: currentFilters.imdbRatingGte ?? '1.0',
              maxValue: currentFilters.imdbRatingLte ?? '10.0',
            })}
          />
        </div>
        <span className="text-lg font-semibold">
          {intl.formatMessage(messages.imdbVotes)}
        </span>
        <div className="relative z-0">
          <MultiRangeSlider
            min={0}
            max={100000}
            defaultMinValue={
              currentFilters.imdbVotesGte
                ? Number(currentFilters.imdbVotesGte)
                : undefined
            }
            defaultMaxValue={
              currentFilters.imdbVotesLte
                ? Number(currentFilters.imdbVotesLte)
                : undefined
            }
            onUpdateMin={(min) => {
              updateQueryParams(
                'imdbVotesGte',
                min !== 0 && Number(currentFilters.imdbVotesLte) !== 100000
                  ? min.toString()
                  : undefined
              );
            }}
            onUpdateMax={(max) => {
              updateQueryParams(
                'imdbVotesLte',
                max !== 100000 && Number(currentFilters.imdbVotesGte) !== 0
                  ? max.toString()
                  : undefined
              );
            }}
            subText={intl.formatMessage(messages.imdbVotesText, {
              minValue: currentFilters.imdbVotesGte ?? 0,
              maxValue: currentFilters.imdbVotesLte ?? 100000,
            })}
          />
        </div>
        <span className="text-lg font-semibold">
          {intl.formatMessage(messages.rtCritics)}
        </span>
        <div className="relative z-0">
          <MultiRangeSlider
            min={0}
            max={100}
            defaultMinValue={
              currentFilters.rtCriticsGte
                ? Number(currentFilters.rtCriticsGte)
                : undefined
            }
            defaultMaxValue={
              currentFilters.rtCriticsLte
                ? Number(currentFilters.rtCriticsLte)
                : undefined
            }
            onUpdateMin={(min) => {
              updateQueryParams(
                'rtCriticsGte',
                min !== 0 && Number(currentFilters.rtCriticsLte) !== 100
                  ? min.toString()
                  : undefined
              );
            }}
            onUpdateMax={(max) => {
              updateQueryParams(
                'rtCriticsLte',
                max !== 100 && Number(currentFilters.rtCriticsGte) !== 0
                  ? max.toString()
                  : undefined
              );
            }}
            subText={intl.formatMessage(messages.rtCriticsText, {
              minValue: currentFilters.rtCriticsGte ?? 0,
              maxValue: currentFilters.rtCriticsLte ?? 100,
            })}
          />
        </div>
        <span className="text-lg font-semibold">
          {intl.formatMessage(messages.rtAudience)}
        </span>
        <div className="relative z-0">
          <MultiRangeSlider
            min={0}
            max={100}
            defaultMinValue={
              currentFilters.rtAudienceGte
                ? Number(currentFilters.rtAudienceGte)
                : undefined
            }
            defaultMaxValue={
              currentFilters.rtAudienceLte
                ? Number(currentFilters.rtAudienceLte)
                : undefined
            }
            onUpdateMin={(min) => {
              updateQueryParams(
                'rtAudienceGte',
                min !== 0 && Number(currentFilters.rtAudienceLte) !== 100
                  ? min.toString()
                  : undefined
              );
            }}
            onUpdateMax={(max) => {
              updateQueryParams(
                'rtAudienceLte',
                max !== 100 && Number(currentFilters.rtAudienceGte) !== 0
                  ? max.toString()
                  : undefined
              );
            }}
            subText={intl.formatMessage(messages.rtAudienceText, {
              minValue: currentFilters.rtAudienceGte ?? 0,
              maxValue: currentFilters.rtAudienceLte ?? 100,
            })}
          />
        </div>
        <span className="text-lg font-semibold">
          {intl.formatMessage(messages.metacritic)}
        </span>
        <div className="relative z-0">
          <MultiRangeSlider
            min={0}
            max={100}
            defaultMinValue={
              currentFilters.metacriticGte
                ? Number(currentFilters.metacriticGte)
                : undefined
            }
            defaultMaxValue={
              currentFilters.metacriticLte
                ? Number(currentFilters.metacriticLte)
                : undefined
            }
            onUpdateMin={(min) => {
              updateQueryParams(
                'metacriticGte',
                min !== 0 && Number(currentFilters.metacriticLte) !== 100
                  ? min.toString()
                  : undefined
              );
            }}
            onUpdateMax={(max) => {
              updateQueryParams(
                'metacriticLte',
                max !== 100 && Number(currentFilters.metacriticGte) !== 0
                  ? max.toString()
                  : undefined
              );
            }}
            subText={intl.formatMessage(messages.metacriticText, {
              minValue: currentFilters.metacriticGte ?? 0,
              maxValue: currentFilters.metacriticLte ?? 100,
            })}
          />
        </div>
        <span className="text-lg font-semibold">
          {intl.formatMessage(messages.traktScore)}
        </span>
        <div className="relative z-0">
          <MultiRangeSlider
            min={0}
            max={10}
            step={0.1}
            defaultMinValue={
              currentFilters.traktRatingGte
                ? Number(currentFilters.traktRatingGte)
                : undefined
            }
            defaultMaxValue={
              currentFilters.traktRatingLte
                ? Number(currentFilters.traktRatingLte)
                : undefined
            }
            onUpdateMin={(min) => {
              updateQueryParams(
                'traktRatingGte',
                min !== 0 && Number(currentFilters.traktRatingLte) !== 10
                  ? min.toFixed(1)
                  : undefined
              );
            }}
            onUpdateMax={(max) => {
              updateQueryParams(
                'traktRatingLte',
                max !== 10 && Number(currentFilters.traktRatingGte) !== 0
                  ? max.toFixed(1)
                  : undefined
              );
            }}
            subText={intl.formatMessage(messages.traktScoreText, {
              minValue: currentFilters.traktRatingGte ?? '0.0',
              maxValue: currentFilters.traktRatingLte ?? '10.0',
            })}
          />
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-200">
          <input
            type="checkbox"
            className="rounded border-gray-500 bg-gray-800 text-indigo-500"
            checked={currentFilters.includeNoRating !== 'false'}
            onChange={(e) =>
              updateQueryParams(
                'includeNoRating',
                e.target.checked ? undefined : 'false'
              )
            }
          />
          {intl.formatMessage(messages.includeNoRating)}
        </label>
        {supports('watchProviders') && (
          <>
            <span className="text-lg font-semibold">
              {intl.formatMessage(messages.streamingservices)}
            </span>
            <WatchProviderSelector
              type={type}
              region={currentFilters.watchRegion}
              activeProviders={
                currentFilters.watchProviders
                  ?.split('|')
                  .map((v) => Number(v)) ?? []
              }
              onChange={(region, providers) => {
                if (providers.length) {
                  batchUpdateQueryParams({
                    watchRegion: region,
                    watchProviders: providers.join('|'),
                  });
                } else {
                  batchUpdateQueryParams({
                    watchRegion: undefined,
                    watchProviders: undefined,
                  });
                }
              }}
            />
          </>
        )}
        <div className="pt-4">
          <Button
            className="w-full"
            disabled={activeCount === 0}
            onClick={() => {
              markDiscoverDefaultsCleared(user?.id);
              const copyCurrent = Object.assign({}, currentFilters);
              (
                Object.keys(copyCurrent) as (keyof typeof currentFilters)[]
              ).forEach((k) => {
                copyCurrent[k] = undefined;
              });
              batchUpdateQueryParams({
                ...copyCurrent,
                ignoreWatched: 'false',
                ignoreCollected: 'false',
                ignoreWatchlisted: 'false',
                hideUnmapped: 'false',
              });
              onClose();
            }}
          >
            <XCircleIcon />
            <span>{intl.formatMessage(messages.clearfilters)}</span>
          </Button>
        </div>
      </div>
    </SlideOver>
  );
};

export default FilterSlideover;
