import { addDays, startOfDay } from '@app/components/Calendar/calendarUtils';
import { calendarDateFromInput } from '@app/components/Calendar/queryState';
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
  ArrowPathIcon,
  CalendarDaysIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ListBulletIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { FunnelIcon } from '@heroicons/react/24/solid';
import type { CalendarItem } from '@server/interfaces/api/calendarInterfaces';
import { toCalendarDateKey } from '@server/lib/releases/calendarDateKey';
import { useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';
import AgendaView from './AgendaView';
import CalendarDetails from './CalendarDetails';
import CalendarFilters from './CalendarFilters';
import { CalendarCard } from './CalendarItemPresentation';
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

const EmptyCalendar = ({
  hasFilters,
  onReset,
  onShowAll,
}: {
  hasFilters: boolean;
  onReset: () => void;
  onShowAll: () => void;
}) => {
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
        noServices
          ? messages.noServicesTitle
          : hasFilters
            ? messages.filteredEmptyTitle
            : messages.emptyTitle
      )}
      description={intl.formatMessage(
        noServices
          ? messages.noServicesDescription
          : hasFilters
            ? messages.filteredEmptyDescription
            : messages.emptyDescription
      )}
      action={
        <div className="flex flex-wrap justify-center gap-2">
          {!noServices ? (
            <Button
              buttonType="primary"
              className="min-h-11"
              onClick={hasFilters ? onReset : onShowAll}
            >
              {intl.formatMessage(
                hasFilters ? messages.clearFilters : messages.allMonitored
              )}
            </Button>
          ) : null}
          <LinkButton
            to={canConnect ? '/settings/integrations' : '/'}
            buttonType={noServices ? 'primary' : 'default'}
            className="min-h-11"
          >
            {intl.formatMessage(
              canConnect ? messages.noServicesSettings : messages.discover
            )}
          </LinkButton>
        </div>
      }
    />
  );
};

const Calendar = () => {
  const intl = useIntl();
  const {
    anchorDate,
    data,
    error,
    filters,
    isLoading,
    isValidating,
    movePeriod,
    mutate,
    range,
    resetFilters,
    setAnchorDate,
    setFilters,
    setView,
    view,
  } = useCalendarPageState();
  const dateId = useId();
  const refreshRef = useRef<HTMLButtonElement>(null);
  const [dateInput, setDateInput] = useState(toCalendarDateKey(anchorDate));
  useEffect(() => setDateInput(toCalendarDateKey(anchorDate)), [anchorDate]);
  const refreshCalendar = async () => {
    try {
      await mutate();
    } catch {
      // SWR exposes the error alongside any cached releases for this period.
    } finally {
      window.requestAnimationFrame(() => {
        if (document.activeElement === document.body)
          refreshRef.current?.focus({ preventScroll: true });
      });
    }
  };
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
  const filterChips = [
    ...(filters.scope === 'all'
      ? [
          {
            id: 'scope',
            label: intl.formatMessage(messages.allMonitored),
            remove: () => setFilters.setScope('mine'),
          },
        ]
      : []),
    ...(filters.mediaType
      ? [
          {
            id: 'media',
            label: intl.formatMessage(
              filters.mediaType === 'movie' ? messages.movies : messages.series
            ),
            remove: () => setFilters.setMediaType(''),
          },
        ]
      : []),
    ...(filters.source
      ? [
          {
            id: 'source',
            label: filters.source === 'radarr' ? 'Radarr' : 'Sonarr',
            remove: () => setFilters.setSource(''),
          },
        ]
      : []),
    ...(filters.is4k
      ? [
          {
            id: '4k',
            label: intl.formatMessage(messages.include4k),
            remove: () => setFilters.setIs4k(false),
          },
        ]
      : []),
  ];
  const monthTitle = intl.formatDate(anchorDate, {
    month: 'long',
    year: 'numeric',
  });
  const rangeTitle = intl.formatMessage(messages.showing, {
    start: intl.formatDate(range.start, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }),
    end: intl.formatDate(addDays(range.end, -1), {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
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
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              ariaLabel={intl.formatMessage(messages.viewMode)}
              className="inline-grid min-w-[9rem] flex-1 sm:min-w-[14rem] sm:flex-none [&_svg]:hidden sm:[&_svg]:block"
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
            <Button
              onClick={() => setFiltersOpen(true)}
              className="min-h-11"
              aria-label={intl.formatMessage(messages.filterButton, {
                count: activeFilterCount,
              })}
            >
              <FunnelIcon className="hidden sm:block" />
              <span>{intl.formatMessage(messages.filters)}</span>
              {activeFilterCount > 0 ? (
                <span
                  aria-hidden="true"
                  className="ml-2 rounded-full bg-indigo-500/20 px-2 text-indigo-200"
                >
                  {activeFilterCount}
                </span>
              ) : null}
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl
            ariaLabel={intl.formatMessage(messages.scope)}
            className="w-full sm:inline-grid sm:w-auto sm:min-w-[20rem]"
            value={filters.scope}
            wrapLabels
            onChange={setFilters.setScope}
            options={[
              { value: 'mine', label: intl.formatMessage(messages.mine) },
              {
                value: 'all',
                label: intl.formatMessage(messages.allMonitored),
              },
            ]}
          />
          {filterChips.map(({ id, label, remove }) => (
            <button
              key={id}
              type="button"
              aria-label={intl.formatMessage(messages.removeFilter, {
                filter: label,
              })}
              onClick={remove}
              className="flex min-h-11 items-center gap-2 rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 text-sm text-indigo-200 hover:bg-indigo-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              {label}
              <XMarkIcon aria-hidden="true" className="h-4 w-4" />
            </button>
          ))}
          {activeFilterCount > 0 ? (
            <button
              type="button"
              onClick={resetFilters}
              className="min-h-11 rounded-md px-3 text-sm text-gray-300 underline underline-offset-4 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              {intl.formatMessage(messages.clearFilters)}
            </button>
          ) : null}
        </div>
        {data?.partialSources?.length ? (
          <Alert
            type="warning"
            title={intl.formatMessage(messages.partialTitle)}
          >
            {intl.formatMessage(messages.partialDescription)}
          </Alert>
        ) : null}
        <div className="rounded-lg border border-gray-700 bg-gray-800/70 px-3 py-2">
          <div className="flex items-center justify-between gap-2">
            <Button
              buttonSize="sm"
              className="min-h-11 min-w-11 shrink-0"
              onClick={() => movePeriod(-1)}
              aria-label={intl.formatMessage(
                view === 'month'
                  ? messages.previousMonth
                  : messages.previousAgenda
              )}
            >
              <ChevronLeftIcon className="h-5 w-5" />
            </Button>
            <div className="min-w-0 text-center">
              <div role="status" className="font-semibold text-white">
                {view === 'month' ? monthTitle : rangeTitle}
              </div>
              <div className="flex justify-center gap-1">
                <button
                  onClick={() => setAnchorDate(startOfDay(new Date()))}
                  className="min-h-11 rounded px-3 text-sm font-medium text-indigo-300 transition hover:text-indigo-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                >
                  {intl.formatMessage(messages.today)}
                </button>
                <Button
                  ref={refreshRef}
                  buttonSize="sm"
                  className="min-h-11 min-w-11"
                  disabled={isValidating}
                  onClick={() => void refreshCalendar()}
                  aria-label={intl.formatMessage(messages.refresh)}
                  title={intl.formatMessage(messages.refresh)}
                >
                  <ArrowPathIcon
                    className={isValidating ? 'animate-spin' : undefined}
                  />
                </Button>
              </div>
            </div>
            <Button
              buttonSize="sm"
              className="min-h-11 min-w-11 shrink-0"
              onClick={() => movePeriod(1)}
              aria-label={intl.formatMessage(
                view === 'month' ? messages.nextMonth : messages.nextAgenda
              )}
            >
              <ChevronRightIcon className="h-5 w-5" />
            </Button>
          </div>
          <form
            className="mt-2 flex items-end gap-2 border-t border-gray-700 pt-3 sm:justify-center"
            onSubmit={(event) => {
              event.preventDefault();
              const date = calendarDateFromInput(dateInput);
              if (date) setAnchorDate(date);
            }}
          >
            <label
              htmlFor={dateId}
              className="flex min-w-0 flex-1 flex-col gap-1 text-xs text-gray-400 sm:flex-none"
            >
              <span>{intl.formatMessage(messages.jumpToDate)}</span>
              <input
                id={dateId}
                type="date"
                min="1000-01-01"
                max="9999-12-31"
                required
                value={dateInput}
                onChange={(event) => setDateInput(event.target.value)}
                className="min-h-11 w-full min-w-0 rounded-md border border-gray-500 bg-gray-700 px-3 text-sm text-white [color-scheme:dark] focus:outline-none focus:ring-2 focus:ring-indigo-500 sm:w-48"
              />
            </label>
            <Button
              type="submit"
              className="min-h-11"
              aria-label={intl.formatMessage(messages.goToDate)}
            >
              {intl.formatMessage(messages.go)}
            </Button>
          </form>
        </div>
        {data && !isLoading && !error && (
          <p role="status" className="text-sm text-gray-400">
            {intl.formatMessage(
              isValidating ? messages.refreshing : messages.releaseCount,
              { count: items.length }
            )}
          </p>
        )}
        {error ? (
          <Alert
            type="error"
            title={intl.formatMessage(
              data ? messages.refreshError : messages.errorTitle
            )}
          >
            {intl.formatMessage(
              data ? messages.cachedResults : messages.errorDescription
            )}{' '}
            <button
              className="ml-1 min-h-11 underline"
              disabled={isValidating}
              onClick={() => void refreshCalendar()}
            >
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
        {!isLoading && !error && !items.length ? (
          <EmptyCalendar
            hasFilters={activeFilterCount > 0}
            onReset={resetFilters}
            onShowAll={() => setFilters.setScope('all')}
          />
        ) : null}
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
        footer={
          <div className="flex gap-2">
            <Button
              className={`min-h-11 flex-1 ${activeFilterCount === 0 ? 'cursor-default opacity-50' : ''}`}
              aria-disabled={activeFilterCount === 0}
              onClick={() => {
                if (activeFilterCount > 0) resetFilters();
              }}
            >
              {intl.formatMessage(messages.clearFilters)}
            </Button>
            <Button
              buttonType="primary"
              className="min-h-11 flex-1"
              onClick={() => setFiltersOpen(false)}
            >
              {intl.formatMessage(
                isLoading ? messages.showCalendar : messages.showResults,
                {
                  count: items.length,
                }
              )}
            </Button>
          </div>
        }
      >
        <CalendarFilters value={filters} setFilters={setFilters} />
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
            <CalendarCard
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
