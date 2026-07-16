import useSettings from '@app/hooks/useSettings';
import { useUpdateQueryParams } from '@app/hooks/useUpdateQueryParams';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { CircleStackIcon } from '@heroicons/react/24/solid';
import { useRouter } from 'next/router';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Discover.TraktDiscoverFilters', {
  anime: 'Anime',
  hideCollected: 'Hide collected',
  hideWatchlisted: 'Hide watchlisted',
  hideWatched: 'Hide watched',
});

type TraktMediaType = 'all' | 'movie' | 'tv' | 'anime';

interface TraktDiscoverFiltersProps {
  showRecommendationFilters?: boolean;
  showHideWatchedFilter?: boolean;
}

const TraktDiscoverFilters = ({
  showRecommendationFilters = false,
  showHideWatchedFilter = true,
}: TraktDiscoverFiltersProps) => {
  const intl = useIntl();
  const router = useRouter();
  const settings = useSettings();
  const { user } = useUser();
  const updateQueryParams = useUpdateQueryParams({});
  const { data: traktStatus } = useSWR<{
    connected: boolean;
    hideWatched?: boolean;
  }>(
    showHideWatchedFilter && settings.currentSettings.traktConfigured && user
      ? `/api/v1/user/${user.id}/settings/linked-accounts/trakt`
      : null
  );

  const currentType: TraktMediaType =
    router.query.type === 'movie' ||
    router.query.type === 'tv' ||
    router.query.type === 'anime'
      ? router.query.type
      : 'all';
  const ignoreCollected = router.query.ignoreCollected === 'true';
  const ignoreWatchlisted = router.query.ignoreWatchlisted === 'true';
  const ignoreWatched =
    router.query.ignoreWatched === 'true' ||
    (router.query.ignoreWatched !== 'false' &&
      traktStatus?.hideWatched === true);

  return (
    <div className="mt-2 flex flex-grow flex-col sm:flex-row lg:flex-grow-0">
      <div className="mb-2 flex flex-grow sm:mb-0 sm:mr-2 lg:flex-grow-0">
        <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-sm text-gray-100">
          <CircleStackIcon className="h-6 w-6" />
        </span>
        <select
          id="traktMediaType"
          name="traktMediaType"
          className="rounded-r-only"
          value={currentType}
          onChange={(e) => {
            const value = e.target.value as TraktMediaType;
            updateQueryParams('type', value === 'all' ? undefined : value);
          }}
        >
          <option value="all">{intl.formatMessage(globalMessages.all)}</option>
          <option value="movie">
            {intl.formatMessage(globalMessages.movies)}
          </option>
          <option value="tv">
            {intl.formatMessage(globalMessages.tvshows)}
          </option>
          <option value="anime">{intl.formatMessage(messages.anime)}</option>
        </select>
      </div>
      {(showRecommendationFilters || showHideWatchedFilter) && (
        <div className="mb-2 flex flex-col gap-2 sm:mb-0 sm:flex-row sm:items-center sm:gap-4">
          {showHideWatchedFilter && traktStatus?.connected && (
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
          )}
          {showRecommendationFilters && (
            <>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-200">
                <input
                  type="checkbox"
                  className="rounded border-gray-500 bg-gray-800 text-indigo-500"
                  checked={ignoreCollected}
                  onChange={(e) =>
                    updateQueryParams(
                      'ignoreCollected',
                      e.target.checked ? 'true' : undefined
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
                      e.target.checked ? 'true' : undefined
                    )
                  }
                />
                {intl.formatMessage(messages.hideWatchlisted)}
              </label>
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default TraktDiscoverFilters;
