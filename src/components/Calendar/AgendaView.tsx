import { toLocalDate } from '@app/components/Calendar/calendarUtils';
import type { CalendarItem } from '@server/interfaces/api/calendarInterfaces';
import { useIntl } from 'react-intl';
import { CalendarCard } from './CalendarItemPresentation';

const AgendaView = ({
  items,
  onSelect,
}: {
  items: CalendarItem[];
  onSelect: (item: CalendarItem) => void;
}) => {
  const intl = useIntl();
  const grouped = items.reduce<Record<string, CalendarItem[]>>(
    (groups, item) => {
      const date = toLocalDate(item.startsAt, item.allDay);
      const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
      (groups[key] ??= []).push(item);
      return groups;
    },
    {}
  );
  return (
    <div className="space-y-6">
      {Object.values(grouped).map((dayItems) => {
        const date = toLocalDate(dayItems[0].startsAt, dayItems[0].allDay);
        return (
          <section key={date.toISOString()}>
            <h2 className="sticky top-0 z-10 mb-2 border-b border-gray-700 bg-gray-900/95 py-2 text-sm font-semibold text-gray-200 backdrop-blur">
              {intl.formatDate(date, {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
              })}
            </h2>
            <div className="space-y-2">
              {dayItems.map((item) => (
                <CalendarCard
                  item={item}
                  key={item.id}
                  onClick={() => onSelect(item)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
};

export default AgendaView;
