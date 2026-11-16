import type { FilterOptions } from '@app/components/Discover/constants';
import defineMessages from '@app/utils/defineMessages';
import Datepicker from '@seerr-team/react-tailwindcss-datepicker';
import { useId } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.FilterSlideover', {
  releaseDate: 'Release Date',
  firstAirDate: 'First Air Date',
  releaseOrAirDate: 'Release / First Air Date',
  from: 'From',
  to: 'To',
});

type DateField =
  | 'primaryReleaseDateGte'
  | 'primaryReleaseDateLte'
  | 'firstAirDateGte'
  | 'firstAirDateLte';
interface Props {
  type: 'movie' | 'tv' | 'all';
  currentFilters: FilterOptions;
  onChange: (field: DateField, value?: string) => void;
}

const ReleaseDateFilter = ({ type, currentFilters, onChange }: Props) => {
  const intl = useIntl();
  const id = useId();
  const dateGte = type === 'tv' ? 'firstAirDateGte' : 'primaryReleaseDateGte';
  const dateLte = type === 'tv' ? 'firstAirDateLte' : 'primaryReleaseDateLte';
  return (
    <div>
      <div className="mb-2 text-lg font-semibold">
        {intl.formatMessage(
          type === 'tv'
            ? messages.firstAirDate
            : type === 'all'
              ? messages.releaseOrAirDate
              : messages.releaseDate
        )}
      </div>
      <div className="relative z-40 flex space-x-2">
        {(
          [
            { key: dateGte, name: 'fromdate', label: messages.from },
            { key: dateLte, name: 'todate', label: messages.to },
          ] as const
        ).map(({ key, name, label }) => (
          <div key={key} className="flex flex-col">
            <label htmlFor={`${id}-${name}`} className="mb-2">
              {intl.formatMessage(label)}
            </label>
            <Datepicker
              key={`${key}:${currentFilters[key] ?? ''}`}
              primaryColor="indigo"
              value={{
                startDate: currentFilters[key] ?? null,
                endDate: currentFilters[key] ?? null,
              }}
              onChange={(value) =>
                onChange(
                  key,
                  value?.startDate ? (value.startDate as string) : undefined
                )
              }
              inputId={`${id}-${name}`}
              inputName={name}
              useRange={false}
              asSingle
              containerClassName="datepicker-wrapper"
              inputClassName="pr-1 sm:pr-4 text-base leading-5"
            />
          </div>
        ))}
      </div>
    </div>
  );
};
export default ReleaseDateFilter;
