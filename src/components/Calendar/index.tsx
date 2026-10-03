import { addDays, startOfDay } from '@app/components/Calendar/calendarUtils';
import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import EmptyState from '@app/components/Common/EmptyState';
import Header from '@app/components/Common/Header';
import LinkButton from '@app/components/Common/LinkButton';
import PageTitle from '@app/components/Common/PageTitle';
import SegmentedControl from '@app/components/Common/SegmentedControl';
import SlideOver from '@app/components/Common/SlideOver';
import { Permission, useUser } from '@app/hooks/useUser';
import {
  CalendarDaysIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ListBulletIcon,
} from '@heroicons/react/24/outline';
import { FunnelIcon } from '@heroicons/react/24/solid';
import type { CalendarItem } from '@server/interfaces/api/calendarInterfaces';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
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
  const { hasPermission } = useUser();
  const { data: radarr } = useSWR<unknown[]>('/api/v1/service/radarr');
  const { data: sonarr } = useSWR<unknown[]>('/api/v1/service/sonarr');
  // Releases come only from Sonarr and Radarr, so without either the calendar
  // stays empty however much is requested.
  const noServices = !!radarr && !!sonarr && !radarr.length && !sonarr.length;
  const canConnect = noServices && hasPermission(Permission.ADMIN);
  return (
    <EmptyState
      icon={CalendarDaysIcon}
      title={intl.formatMessage(
        noServices ? messages.noServicesTitle : messages.emptyTitle
      )}
      description={intl.formatMessage(
        noServices ? messages.noServicesDescription : messages.emptyDescription
      )}
      action={
        <LinkButton
          to={canConnect ? '/settings/integrations' : '/'}
          buttonType="primary"
        >
          {intl.formatMessage(
            canConnect ? messages.noServicesSettings : messages.discover
          )}
        </LinkButton>
      }
    />
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
  // Keep the day list rendered while its panel slides out.
  const [shownDay, setShownDay] = useState(selectedDay);
  useEffect(() => {
    if (selectedDay) setShownDay(selectedDay);
  }, [selectedDay]);
  const items = data?.results ?? [];
  const activeFilterCount =
    Number(filters.scope !== 'mine') +
    Number(!!filters.mediaType) +
    Number(!!filters.source) +
    Number(filters.is4k);
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
        <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
          <Header subtext={intl.formatMessage(messages.description)}>
            {intl.formatMessage(messages.calendar)}
          </Header>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <SegmentedControl
              ariaLabel={intl.formatMessage(messages.viewMode)}
              size="sm"
              className="hidden lg:inline-grid lg:min-w-[14rem]"
              value={view}
              onChange={setView}
              options={[
                {
                  value: 'month',
                  label: intl.formatMessage(messages.month),
                  icon: CalendarDaysIcon,
                },
                {
                  value: 'agenda',
                  label: intl.formatMessage(messages.agenda),
                  icon: ListBulletIcon,
                },
              ]}
            />
            <Button onClick={() => setFiltersOpen(true)}>
              <FunnelIcon />
              <span>
                {intl.formatMessage(messages.activeFilters, {
                  count: activeFilterCount,
                })}
              </span>
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
              className="text-xs font-medium text-indigo-400 transition hover:text-indigo-300"
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
        subText={intl.formatMessage(messages.activeFilters, {
          count: activeFilterCount,
        })}
        onClose={() => setFiltersOpen(false)}
      >
        <CalendarFilters
          activeFilterCount={activeFilterCount}
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
          shownDay
            ? intl.formatMessage(messages.dayReleases, {
                date: intl.formatDate(shownDay.date, {
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
          {shownDay?.items.map((item) => (
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
