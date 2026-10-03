import Button from '@app/components/Common/Button';
import SegmentedControl from '@app/components/Common/SegmentedControl';
import globalMessages from '@app/i18n/globalMessages';
import { XCircleIcon } from '@heroicons/react/24/outline';
import type {
  CalendarMediaType,
  CalendarScope,
  CalendarSource,
} from '@server/interfaces/api/calendarInterfaces';
import { useIntl } from 'react-intl';
import messages from './calendarMessages';
import type { CalendarFilterState } from './calendarUtils';

type Props = {
  activeFilterCount: number;
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

type MediaOption = CalendarMediaType | 'all';
type SourceOption = CalendarSource | 'all';

const CalendarFilters = ({
  activeFilterCount,
  hasAdminPermission,
  onClose,
  setFilters,
  value,
}: Props) => {
  const intl = useIntl();
  return (
    <div className="flex flex-col space-y-4">
      <div>
        <div className="mb-2 text-lg font-semibold">
          {intl.formatMessage(messages.scope)}
        </div>
        <SegmentedControl<CalendarScope>
          ariaLabel={intl.formatMessage(messages.scope)}
          size="sm"
          value={value.scope}
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
          size="sm"
          value={value.mediaType || 'all'}
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
      {hasAdminPermission ? (
        <>
          <div>
            <div className="mb-2 text-lg font-semibold">
              {intl.formatMessage(messages.source)}
            </div>
            <SegmentedControl<SourceOption>
              ariaLabel={intl.formatMessage(messages.source)}
              size="sm"
              value={value.source || 'all'}
              onChange={(source) =>
                setFilters.setSource(source === 'all' ? '' : source)
              }
              options={[
                {
                  value: 'all',
                  label: intl.formatMessage(messages.allSources),
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
              className="cursor-pointer text-base font-normal text-white"
            >
              {intl.formatMessage(messages.include4k)}
            </label>
          </div>
        </>
      ) : null}
      <div className="pt-4">
        <Button
          className="w-full"
          disabled={activeFilterCount === 0}
          onClick={() => {
            setFilters.setScope('mine');
            setFilters.setMediaType('');
            setFilters.setSource('');
            setFilters.setIs4k(false);
            onClose();
          }}
        >
          <XCircleIcon />
          <span>{intl.formatMessage(messages.clearFilters)}</span>
        </Button>
      </div>
    </div>
  );
};

export default CalendarFilters;
