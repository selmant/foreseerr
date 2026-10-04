import {
  addDays,
  calendarRange,
  sameDay,
  toLocalDate,
} from '@app/components/Calendar/calendarUtils';
import type { CalendarItem } from '@server/interfaces/api/calendarInterfaces';
import { useIntl } from 'react-intl';
import { CalendarChip } from './CalendarItemPresentation';
import messages from './calendarMessages';

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
      <p className="border-b border-gray-700 px-3 py-2 text-xs text-gray-400 lg:hidden">
        {intl.formatMessage(messages.monthHint)}
      </p>
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
              className={`min-h-20 border-b border-r border-gray-700/80 p-0.5 lg:min-h-28 lg:p-1.5 ${outside ? 'bg-gray-900/30' : ''}`}
            >
              {dayItems.length ? (
                <button
                  type="button"
                  onClick={() => onSelectDay(dayItems, day)}
                  aria-label={`${intl.formatMessage(messages.dayReleases, { date: intl.formatDate(day, { dateStyle: 'full' }) })}: ${intl.formatMessage(messages.dayCount, { count: dayItems.length })}`}
                  className="flex min-h-16 w-full flex-col items-center gap-1 rounded-md py-1 hover:bg-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 lg:hidden"
                >
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${isToday ? 'bg-indigo-600 font-bold text-white' : 'text-gray-300'}`}
                  >
                    {day.getDate()}
                  </span>
                  <span className="rounded-full bg-indigo-500/20 px-2 text-xs font-medium text-indigo-200">
                    {dayItems.length}
                  </span>
                </button>
              ) : (
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full text-xs lg:hidden ${isToday ? 'bg-indigo-600 font-bold text-white' : 'text-gray-400'}`}
                >
                  {day.getDate()}
                </span>
              )}
              <div
                className={`mb-1 hidden h-6 w-6 items-center justify-center rounded-full text-xs lg:flex ${isToday ? 'bg-indigo-600 font-bold text-white' : 'text-gray-400'}`}
              >
                {day.getDate()}
              </div>
              <div className="hidden space-y-1 lg:block">
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
                    className="min-h-6 w-full rounded px-1.5 text-left text-xs font-medium text-indigo-300 transition hover:text-indigo-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                  >
                    {intl.formatMessage(messages.moreReleases, {
                      count: dayItems.length - 3,
                    })}
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
