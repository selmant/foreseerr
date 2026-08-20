import {
  addDays,
  calendarRange,
  sameDay,
  toLocalDate,
} from '@app/components/Calendar/calendarUtils';
import type { CalendarItem } from '@server/interfaces/api/calendarInterfaces';
import { useIntl } from 'react-intl';
import { CalendarChip } from './CalendarItemPresentation';

type Props = {
  anchorDate: Date;
  items: CalendarItem[];
  onSelect: (item: CalendarItem) => void;
  onSelectDay: (items: CalendarItem[], date: Date) => void;
};

const MonthView = ({ anchorDate, items, onSelect, onSelectDay }: Props) => {
  const intl = useIntl();
  const range = calendarRange(anchorDate, 'month');
  const days = Array.from({ length: 42 }, (_, index) =>
    addDays(range.start, index)
  );
  const weekdays = Array.from({ length: 7 }, (_, index) =>
    intl.formatDate(addDays(range.start, index), { weekday: 'short' })
  );
  return (
    <div className="overflow-hidden rounded-lg border border-gray-700 bg-gray-800/60">
      <div className="grid grid-cols-7 border-b border-gray-700 bg-gray-800">
        {weekdays.map((day) => (
          <div
            key={day}
            className="px-2 py-2 text-center text-xs font-semibold uppercase tracking-wide text-gray-400"
          >
            {day}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((day) => {
          const dayItems = items.filter((item) =>
            sameDay(toLocalDate(item.startsAt, item.allDay), day)
          );
          const outside = day.getMonth() !== anchorDate.getMonth();
          const isToday = sameDay(day, new Date());
          return (
            <div
              key={day.toISOString()}
              className={`min-h-28 border-b border-r border-gray-700/80 p-1.5 ${outside ? 'bg-gray-900/30' : ''}`}
            >
              <div
                className={`mb-1 flex h-6 w-6 items-center justify-center rounded-full text-xs ${isToday ? 'bg-indigo-600 font-bold text-white' : 'text-gray-400'}`}
              >
                {day.getDate()}
              </div>
              <div className="space-y-1">
                {dayItems.slice(0, 3).map((item) => (
                  <CalendarChip
                    item={item}
                    key={item.id}
                    onClick={() => onSelect(item)}
                  />
                ))}
                {dayItems.length > 3 ? (
                  <button
                    onClick={() => onSelectDay(dayItems, day)}
                    className="w-full text-left text-xs text-indigo-300 hover:text-indigo-100"
                  >
                    +{dayItems.length - 3} more
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default MonthView;
