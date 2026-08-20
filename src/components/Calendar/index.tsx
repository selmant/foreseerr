import { addDays, startOfDay } from '@app/components/Calendar/calendarUtils';
import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import Header from '@app/components/Common/Header';
import PageTitle from '@app/components/Common/PageTitle';
import SlideOver from '@app/components/Common/SlideOver';
import { Permission, useUser } from '@app/hooks/useUser';
import {
  AdjustmentsHorizontalIcon,
  CalendarDaysIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ListBulletIcon,
} from '@heroicons/react/24/outline';
import type { CalendarItem } from '@server/interfaces/api/calendarInterfaces';
import Link from 'next/link';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import AgendaView from './AgendaView';
import CalendarDetails from './CalendarDetails';
import CalendarFilters from './CalendarFilters';
import { CalendarChip } from './CalendarItemPresentation';
import MonthView from './MonthView';
import messages from './calendarMessages';
import type { CalendarView } from './calendarUtils';
import { useCalendarPageState } from './useCalendarPageState';

const CalendarSkeleton = ({
  view,
  label,
}: {
  view: CalendarView;
  label: string;
}) => (
  <div
    aria-live="polite"
    className="animate-pulse rounded-lg border border-gray-700 bg-gray-800/60 p-4"
  >
    <span className="sr-only">{label}</span>
    <div
      className={`grid gap-2 ${view === 'month' ? 'grid-cols-7' : 'grid-cols-1'}`}
    >
      {Array.from({ length: view === 'month' ? 28 : 8 }, (_, index) => (
        <div
          key={index}
          className={`rounded bg-gray-700/70 ${view === 'month' ? 'h-28' : 'h-20'}`}
        />
      ))}
    </div>
  </div>
);

const EmptyCalendar = () => {
  const intl = useIntl();
  return (
    <div className="rounded-lg border border-dashed border-gray-600 bg-gray-800/40 px-6 py-16 text-center">
      <CalendarDaysIcon className="mx-auto h-10 w-10 text-gray-500" />
      <h2 className="mt-4 text-lg font-semibold text-white">
        {intl.formatMessage(messages.emptyTitle)}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-gray-400">
        {intl.formatMessage(messages.emptyDescription)}
      </p>
      <Link
        href="/discover"
        className="mt-5 inline-flex rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
      >
        {intl.formatMessage(messages.discover)}
      </Link>
    </div>
  );
};

const Calendar = () => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const {
    anchorDate,
    data,
    error,
    filters,
    isLoading,
    movePeriod,
    mutate,
    range,
    setAnchorDate,
    setFilters,
    setView,
    view,
  } = useCalendarPageState();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<CalendarItem | null>(null);
  const [selectedDay, setSelectedDay] = useState<{
    date: Date;
    items: CalendarItem[];
  } | null>(null);
  const items = data?.results ?? [];
  const monthTitle = intl.formatDate(anchorDate, {
    month: 'long',
    year: 'numeric',
  });
  const rangeTitle = intl.formatMessage(messages.showing, {
    start: intl.formatDate(range.start, { month: 'short', day: 'numeric' }),
    end: intl.formatDate(addDays(range.end, -1), {
      month: 'short',
      day: 'numeric',
    }),
  });

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.calendar)} />
      <div className="space-y-5">
        <div className="flex flex-col justify-between gap-4 xl:flex-row xl:items-end">
          <div>
            <Header>{intl.formatMessage(messages.calendar)}</Header>
            <p className="mt-1 text-sm text-gray-400">
              {intl.formatMessage(messages.description)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="hidden rounded-md border border-gray-600 bg-gray-800 p-0.5 lg:flex">
              <button
                onClick={() => setView('month')}
                className={`rounded px-3 py-1.5 text-sm ${view === 'month' ? 'bg-indigo-600 text-white' : 'text-gray-300 hover:text-white'}`}
              >
                <CalendarDaysIcon className="mr-1 inline h-4 w-4" />
                {intl.formatMessage(messages.month)}
              </button>
              <button
                onClick={() => setView('agenda')}
                className={`rounded px-3 py-1.5 text-sm ${view === 'agenda' ? 'bg-indigo-600 text-white' : 'text-gray-300 hover:text-white'}`}
              >
                <ListBulletIcon className="mr-1 inline h-4 w-4" />
                {intl.formatMessage(messages.agenda)}
              </button>
            </div>
            <Button buttonSize="sm" onClick={() => setFiltersOpen(true)}>
              <AdjustmentsHorizontalIcon className="mr-1 h-4 w-4" />
              {intl.formatMessage(messages.filters)}
            </Button>
          </div>
        </div>
        {data?.partialSources?.length ? (
          <Alert
            type="warning"
            title={intl.formatMessage(messages.partialTitle)}
          >
            {intl.formatMessage(messages.partialDescription)}
          </Alert>
        ) : null}
        <div className="flex items-center justify-between rounded-lg border border-gray-700 bg-gray-800/70 px-3 py-2">
          <Button
            buttonSize="sm"
            onClick={() => movePeriod(-1)}
            aria-label={intl.formatMessage(messages.previous)}
          >
            <ChevronLeftIcon className="h-5 w-5" />
          </Button>
          <div className="text-center">
            <div className="font-semibold text-white">
              {view === 'month' ? monthTitle : rangeTitle}
            </div>
            <button
              onClick={() => setAnchorDate(startOfDay(new Date()))}
              className="text-xs text-indigo-300 hover:text-indigo-100"
            >
              {intl.formatMessage(messages.today)}
            </button>
          </div>
          <Button
            buttonSize="sm"
            onClick={() => movePeriod(1)}
            aria-label={intl.formatMessage(messages.next)}
          >
            <ChevronRightIcon className="h-5 w-5" />
          </Button>
        </div>
        {error && !data ? (
          <Alert type="error" title={intl.formatMessage(messages.errorTitle)}>
            {intl.formatMessage(messages.errorDescription)}{' '}
            <button className="ml-1 underline" onClick={() => mutate()}>
              {intl.formatMessage(messages.retry)}
            </button>
          </Alert>
        ) : null}
        {isLoading && !data ? (
          <CalendarSkeleton
            view={view}
            label={intl.formatMessage(messages.loading)}
          />
        ) : null}
        {!isLoading && !error && !items.length ? <EmptyCalendar /> : null}
        {items.length > 0 && view === 'month' ? (
          <MonthView
            anchorDate={anchorDate}
            items={items}
            onSelect={setSelectedItem}
            onSelectDay={(dayItems, date) =>
              setSelectedDay({ items: dayItems, date })
            }
          />
        ) : null}
        {items.length > 0 && view === 'agenda' ? (
          <AgendaView items={items} onSelect={setSelectedItem} />
        ) : null}
      </div>
      <SlideOver
        show={filtersOpen}
        title={intl.formatMessage(messages.filters)}
        onClose={() => setFiltersOpen(false)}
      >
        <CalendarFilters
          hasAdminPermission={hasPermission(Permission.ADMIN)}
          value={filters}
          setFilters={setFilters}
          onClose={() => setFiltersOpen(false)}
        />
      </SlideOver>
      <CalendarDetails
        item={selectedItem}
        onClose={() => setSelectedItem(null)}
      />
      <SlideOver
        show={selectedDay !== null}
        title={
          selectedDay
            ? intl.formatMessage(messages.dayReleases, {
                date: intl.formatDate(selectedDay.date, {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                }),
              })
            : ''
        }
        onClose={() => setSelectedDay(null)}
      >
        <div className="space-y-2">
          {selectedDay?.items.map((item) => (
            <CalendarChip
              item={item}
              key={item.id}
              onClick={() => {
                setSelectedDay(null);
                setSelectedItem(item);
              }}
            />
          ))}
        </div>
      </SlideOver>
    </>
  );
};

export default Calendar;
