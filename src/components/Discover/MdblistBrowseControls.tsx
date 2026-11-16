import Button from '@app/components/Common/Button';
import SlideOver from '@app/components/Common/SlideOver';
import ReleaseDateFilter from '@app/components/Discover/ReleaseDateFilter';
import type { FilterOptions } from '@app/components/Discover/constants';
import {
  useBatchUpdateQueryParams,
  useUpdateQueryParams,
} from '@app/hooks/useUpdateQueryParams';
import { validDateRange } from '@app/utils/mdblistBrowse';
import defineMessages from '@app/utils/defineMessages';
import { BarsArrowDownIcon, FunnelIcon } from '@heroicons/react/24/solid';
import { XCircleIcon } from '@heroicons/react/24/outline';
import { useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.MdblistBrowseControls', {
  filters: 'Filters',
  activefilters:
    '{count, plural, one {# Active Filter} other {# Active Filters}}',
  sort: 'Sort by',
  releaseDate: 'Release Date Descending',
  firstAirDate: 'First Air Date Descending',
  popularity: 'Popularity Descending',
  rating: 'TMDB Rating Descending',
  sourceOrder: 'Source List Order',
  clearfilters: 'Clear Active Filters',
  invalid: 'Enter valid dates, with the first date no later than the last.',
});
export const MdblistSortOptions = ({
  type = 'all',
}: {
  type?: 'movie' | 'tv' | 'all';
}) => {
  const intl = useIntl();
  return (
    <>
      <option
        value={type === 'tv' ? 'first_air_date.desc' : 'release_date.desc'}
      >
        {intl.formatMessage(
          type === 'tv' ? messages.firstAirDate : messages.releaseDate
        )}
      </option>
      <option value="popularity.desc">
        {intl.formatMessage(messages.popularity)}
      </option>
      <option value="vote_average.desc">
        {intl.formatMessage(messages.rating)}
      </option>
      <option value="source">{intl.formatMessage(messages.sourceOrder)}</option>
    </>
  );
};

const dateFields = [
  'primaryReleaseDateGte',
  'primaryReleaseDateLte',
  'firstAirDateGte',
  'firstAirDateLte',
] as const;

interface Props {
  currentFilters: FilterOptions;
  type: 'movie' | 'tv' | 'all';
}

const MdblistBrowseControls = ({ currentFilters, type }: Props) => {
  const intl = useIntl();
  const [show, setShow] = useState(false);
  const updateQueryParams = useUpdateQueryParams({});
  const batchUpdateQueryParams = useBatchUpdateQueryParams({});
  const count = dateFields.filter((field) => currentFilters[field]).length;
  const defaultSort =
    type === 'tv' ? 'first_air_date.desc' : 'release_date.desc';
  const sort =
    currentFilters.sortBy === 'first_air_date.desc' ||
    currentFilters.sortBy === 'release_date.desc'
      ? defaultSort
      : currentFilters.sortBy || 'source';
  return (
    <div className="mt-2 flex flex-grow flex-col sm:flex-row lg:flex-grow-0">
      <div className="mb-2 flex flex-grow sm:mb-0 sm:mr-2 lg:flex-grow-0">
        <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100 sm:text-sm">
          <BarsArrowDownIcon className="h-6 w-6" aria-hidden="true" />
        </span>
        <select
          id="sortBy"
          name="sortBy"
          aria-label={intl.formatMessage(messages.sort)}
          className="rounded-r-only"
          value={sort}
          onChange={(event) => updateQueryParams('sortBy', event.target.value)}
        >
          <MdblistSortOptions type={type} />
        </select>
      </div>
      <SlideOver
        show={show}
        title={intl.formatMessage(messages.filters)}
        subText={intl.formatMessage(messages.activefilters, { count })}
        onClose={() => setShow(false)}
      >
        <div className="flex flex-col space-y-4">
          <ReleaseDateFilter
            type={type}
            currentFilters={currentFilters}
            onChange={updateQueryParams}
          />
          {!validDateRange(currentFilters) && (
            <p role="alert" className="text-sm text-red-300">
              {intl.formatMessage(messages.invalid)}
            </p>
          )}
          <Button
            buttonType="ghost"
            onClick={() =>
              batchUpdateQueryParams(
                Object.fromEntries(
                  dateFields.map((field) => [field, undefined])
                )
              )
            }
          >
            <XCircleIcon />
            <span>{intl.formatMessage(messages.clearfilters)}</span>
          </Button>
        </div>
      </SlideOver>
      <div className="mb-2 flex flex-grow sm:mb-0 lg:flex-grow-0">
        <Button
          onClick={() => setShow(true)}
          className="min-h-[44px] w-full"
          aria-haspopup="dialog"
          aria-expanded={show}
        >
          <FunnelIcon />
          <span>{intl.formatMessage(messages.activefilters, { count })}</span>
        </Button>
      </div>
    </div>
  );
};

export default MdblistBrowseControls;
