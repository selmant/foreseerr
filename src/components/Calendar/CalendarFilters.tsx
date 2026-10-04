import SegmentedControl from '@app/components/Common/SegmentedControl';
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
  setFilters: {
    setScope: (scope: CalendarScope) => void;
    setMediaType: (mediaType: CalendarMediaType | '') => void;
    setSource: (source: CalendarSource | '') => void;
    setIs4k: (is4k: boolean) => void;
  };
  value: CalendarFilterState;
};

type MediaOption = CalendarMediaType | 'all';
type SourceOption = CalendarSource | 'all';

const CalendarFilters = ({ setFilters, value }: Props) => {
  const intl = useIntl();
  return (
    <div className="flex flex-col space-y-4">
      <p className="text-sm text-gray-400">
        {intl.formatMessage(messages.filterHint)}
      </p>
      <div>
        <div className="mb-2 text-lg font-semibold">
          {intl.formatMessage(messages.scope)}
        </div>
        <SegmentedControl<CalendarScope>
          ariaLabel={intl.formatMessage(messages.scope)}
          value={value.scope}
          wrapLabels
          onChange={setFilters.setScope}
          options={[
            { value: 'mine', label: intl.formatMessage(messages.mine) },
            { value: 'all', label: intl.formatMessage(messages.allMonitored) },
          ]}
        />
      </div>
      <div>
        <div className="mb-2 text-lg font-semibold">
          {intl.formatMessage(messages.media)}
        </div>
        <SegmentedControl<MediaOption>
          ariaLabel={intl.formatMessage(messages.media)}
          value={value.mediaType || 'all'}
          wrapLabels
          onChange={(mediaType) =>
            setFilters.setMediaType(mediaType === 'all' ? '' : mediaType)
          }
          options={[
            { value: 'all', label: intl.formatMessage(globalMessages.all) },
            { value: 'movie', label: intl.formatMessage(messages.movies) },
            { value: 'tv', label: intl.formatMessage(messages.series) },
          ]}
        />
      </div>
      <div>
        <div className="mb-2 text-lg font-semibold">
          {intl.formatMessage(messages.source)}
        </div>
        <SegmentedControl<SourceOption>
          ariaLabel={intl.formatMessage(messages.source)}
          value={value.source || 'all'}
          wrapLabels
          onChange={(source) =>
            setFilters.setSource(source === 'all' ? '' : source)
          }
          options={[
            {
              value: 'all',
              label: intl.formatMessage(globalMessages.all),
            },
            { value: 'radarr', label: 'Radarr' },
            { value: 'sonarr', label: 'Sonarr' },
          ]}
        />
      </div>
      <div className="flex items-center space-x-3">
        <input
          id="calendar4kOnly"
          type="checkbox"
          checked={value.is4k}
          onChange={(event) => setFilters.setIs4k(event.target.checked)}
        />
        <label
          htmlFor="calendar4kOnly"
          className="flex min-h-11 cursor-pointer items-center text-base font-normal text-white"
        >
          {intl.formatMessage(messages.include4k)}
        </label>
      </div>
    </div>
  );
};

export default CalendarFilters;
