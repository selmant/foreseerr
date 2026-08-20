import Button from '@app/components/Common/Button';
import globalMessages from '@app/i18n/globalMessages';
import type {
  CalendarMediaType,
  CalendarScope,
  CalendarSource,
} from '@server/interfaces/api/calendarInterfaces';
import { useIntl } from 'react-intl';
import messages from './calendarMessages';
import type { CalendarFilterState } from './calendarUtils';

type Props = {
  hasAdminPermission: boolean;
  onClose: () => void;
  setFilters: {
    setScope: (scope: CalendarScope) => void;
    setMediaType: (mediaType: CalendarMediaType | '') => void;
    setSource: (source: CalendarSource | '') => void;
    setIs4k: (is4k: boolean) => void;
  };
  value: CalendarFilterState;
};

const CalendarFilters = ({
  hasAdminPermission,
  onClose,
  setFilters,
  value,
}: Props) => {
  const intl = useIntl();
  return (
    <>
      <div className="flex flex-col gap-4">
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-gray-200">
            {intl.formatMessage(messages.scope)}
          </legend>
          <div className="grid grid-cols-2 gap-2">
            {(['mine', 'all'] as CalendarScope[]).map((option) => (
              <button
                key={option}
                onClick={() => setFilters.setScope(option)}
                className={`rounded-md border px-3 py-2 text-sm font-medium ${value.scope === option ? 'border-indigo-500 bg-indigo-500/20 text-white' : 'border-gray-600 bg-gray-800 text-gray-300 hover:border-gray-400'}`}
              >
                {intl.formatMessage(
                  option === 'mine' ? messages.mine : messages.allMonitored
                )}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="flex flex-col gap-1 text-sm font-medium text-gray-200">
          {intl.formatMessage(messages.media)}
          <select
            value={value.mediaType}
            onChange={(event) =>
              setFilters.setMediaType(
                event.target.value as CalendarMediaType | ''
              )
            }
            className="rounded-md border-gray-600 bg-gray-800 text-sm text-white focus:border-indigo-500 focus:ring-indigo-500"
          >
            <option value="">{intl.formatMessage(globalMessages.all)}</option>
            <option value="movie">{intl.formatMessage(messages.movies)}</option>
            <option value="tv">{intl.formatMessage(messages.series)}</option>
          </select>
        </label>
        {hasAdminPermission ? (
          <>
            <label className="flex flex-col gap-1 text-sm font-medium text-gray-200">
              {intl.formatMessage(messages.source)}
              <select
                value={value.source}
                onChange={(event) =>
                  setFilters.setSource(
                    event.target.value as CalendarSource | ''
                  )
                }
                className="rounded-md border-gray-600 bg-gray-800 text-sm text-white focus:border-indigo-500 focus:ring-indigo-500"
              >
                <option value="">
                  {intl.formatMessage(messages.allSources)}
                </option>
                <option value="radarr">Radarr</option>
                <option value="sonarr">Sonarr</option>
              </select>
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-gray-200">
              <input
                checked={value.is4k}
                onChange={(event) => setFilters.setIs4k(event.target.checked)}
                type="checkbox"
                className="rounded border-gray-500 bg-gray-800 text-indigo-500 focus:ring-indigo-500"
              />
              {intl.formatMessage(messages.include4k)}
            </label>
          </>
        ) : null}
      </div>
      <Button className="mt-6 w-full" buttonType="primary" onClick={onClose}>
        {intl.formatMessage(messages.view)}
      </Button>
    </>
  );
};

export default CalendarFilters;
