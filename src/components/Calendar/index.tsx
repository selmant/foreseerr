import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import Header from '@app/components/Common/Header';
import PageTitle from '@app/components/Common/PageTitle';
import SlideOver from '@app/components/Common/SlideOver';
import useCalendar from '@app/hooks/useCalendar';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  AdjustmentsHorizontalIcon,
  CalendarDaysIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  FilmIcon,
  ListBulletIcon,
  PlayIcon,
  TvIcon,
} from '@heroicons/react/24/outline';
import type {
  CalendarDateType,
  CalendarItem,
  CalendarMediaType,
  CalendarScope,
  CalendarSource,
} from '@server/interfaces/api/calendarInterfaces';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Calendar', {
  calendar: 'Release Calendar',
  description: 'Plan upcoming movies, seasons, and episodes in one place.',
  month: 'Month',
  agenda: 'Agenda',
  filters: 'Filters',
  scope: 'Scope',
  view: 'View calendar',
  mine: 'Relevant to me',
  allMonitored: 'All monitored',
  source: 'Source',
  media: 'Media',
  allSources: 'All sources',
  movies: 'Movies',
  series: 'Series',
  include4k: '4K only',
  previous: 'Previous period',
  next: 'Next period',
  today: 'Today',
  requested: 'Requested',
  available: 'Available',
  delayed: 'Delayed',
  movedEarlier: 'Moved earlier',
  announced: 'Date announced',
  newSeason: 'New season',
  withdrawn: 'Date withdrawn',
  digital: 'Digital',
  physical: 'Physical',
  theatrical: 'Theatrical',
  air: 'Airs',
  episode: 'Episode',
  season: 'Season',
  watch: 'Watch',
  details: 'View details',
  requestSeason: 'Request season',
  discover: 'Discover titles',
  emptyTitle: 'Nothing upcoming for you yet',
  emptyDescription:
    'Titles you request will appear here when they have an upcoming release date.',
  loading: 'Loading calendar…',
  errorTitle: 'Calendar could not be loaded',
  errorDescription:
    'Try again in a moment. Your existing calendar data was not changed.',
  retry: 'Retry',
  partialTitle: 'Some release sources need attention',
  partialDescription:
    'Results may be incomplete because one or more configured sources have not synced recently.',
  previousDate: 'Previously {date}',
  noDetails: 'No additional dates or links are available for this release.',
  allKnownDates: 'All known dates',
  requestedQuality: '{quality} request',
  countdown: '{count, plural, one {in # day} other {in # days}}',
  todayCountdown: 'Today',
  overdue: 'Released',
  showing: 'Showing {start}–{end}',
  nextMore: 'Next: {title} (+{count} more)',
});

type View = 'month' | 'agenda';

const calendarFilterStorageKey = 'foreseer.calendar.filters';

type CalendarFilterState = {
  scope: CalendarScope;
  mediaType: CalendarMediaType | '';
  source: CalendarSource | '';
  is4k: boolean;
};

const readCalendarFilters = (): CalendarFilterState => {
  const defaults: CalendarFilterState = {
    scope: 'mine',
    mediaType: '',
    source: '',
    is4k: false,
  };

  if (typeof window === 'undefined') return defaults;

  try {
    const stored = JSON.parse(
      window.localStorage.getItem(calendarFilterStorageKey) ?? '{}'
    ) as Partial<CalendarFilterState>;
    return {
      scope: stored.scope === 'all' ? 'all' : defaults.scope,
      mediaType:
        stored.mediaType === 'movie' || stored.mediaType === 'tv'
          ? stored.mediaType
          : defaults.mediaType,
      source:
        stored.source === 'radarr' || stored.source === 'sonarr'
          ? stored.source
          : defaults.source,
      is4k: stored.is4k === true,
    };
  } catch {
    return defaults;
  }
};

const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

const addDays = (date: Date, days: number) => {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
};

const toLocalDate = (value: string, allDay = false) => {
  if (allDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T12:00:00`);
  }
  return new Date(value);
};

const sameDay = (left: Date, right: Date) =>
  left.getFullYear() === right.getFullYear() &&
  left.getMonth() === right.getMonth() &&
  left.getDate() === right.getDate();

const calendarRange = (date: Date, view: View) => {
  if (view === 'agenda') {
    return { start: startOfDay(date), end: addDays(startOfDay(date), 45) };
  }
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  const start = addDays(first, -first.getDay());
  return { start, end: addDays(start, 42) };
};

const formatEpisode = (
  item: CalendarItem,
  intl: ReturnType<typeof useIntl>
) => {
  if (item.seasonNumber === undefined || item.seasonNumber === null)
    return null;
  if (item.episodeNumber !== undefined && item.episodeNumber !== null) {
    return `S${String(item.seasonNumber).padStart(2, '0')}E${String(item.episodeNumber).padStart(2, '0')}`;
  }
  return `${intl.formatMessage(messages.season)} ${item.seasonNumber}`;
};

const getDateBadge = (
  dateType: CalendarDateType,
  intl: ReturnType<typeof useIntl>
) => intl.formatMessage(messages[dateType]);

const Calendar = () => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const initialFilters = useMemo(readCalendarFilters, []);
  const [view, setView] = useState<View>('month');
  const [anchorDate, setAnchorDate] = useState(() => startOfDay(new Date()));
  const [scope, setScope] = useState<CalendarScope>(initialFilters.scope);
  const [mediaType, setMediaType] = useState<CalendarMediaType | ''>(
    initialFilters.mediaType
  );
  const [source, setSource] = useState<CalendarSource | ''>(
    initialFilters.source
  );
  const [is4k, setIs4k] = useState(initialFilters.is4k);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<CalendarItem | null>(null);

  useEffect(() => {
    if (window.matchMedia('(max-width: 1023px)').matches) setView('agenda');
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      calendarFilterStorageKey,
      JSON.stringify({ scope, mediaType, source, is4k })
    );
  }, [scope, mediaType, source, is4k]);

  const range = useMemo(
    () => calendarRange(anchorDate, view),
    [anchorDate, view]
  );
  const { data, error, isLoading, mutate } = useCalendar({
    start: range.start,
    end: range.end,
    scope,
    mediaType: mediaType || undefined,
    source: source || undefined,
    is4k,
    includeEpisodes: true,
  });
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

  const movePeriod = (direction: number) => {
    setAnchorDate((date) =>
      view === 'month'
        ? new Date(date.getFullYear(), date.getMonth() + direction, 1)
        : addDays(date, direction * 45)
    );
  };

  const filters = (
    <div className="flex flex-col gap-4">
      <fieldset>
        <legend className="mb-2 text-sm font-medium text-gray-200">
          {intl.formatMessage(messages.scope)}
        </legend>
        <div className="grid grid-cols-2 gap-2">
          {(['mine', 'all'] as CalendarScope[]).map((option) => (
            <button
              key={option}
              onClick={() => setScope(option)}
              className={`rounded-md border px-3 py-2 text-sm font-medium ${scope === option ? 'border-indigo-500 bg-indigo-500/20 text-white' : 'border-gray-600 bg-gray-800 text-gray-300 hover:border-gray-400'}`}
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
          value={mediaType}
          onChange={(event) =>
            setMediaType(event.target.value as CalendarMediaType | '')
          }
          className="rounded-md border-gray-600 bg-gray-800 text-sm text-white focus:border-indigo-500 focus:ring-indigo-500"
        >
          <option value="">{intl.formatMessage(globalMessages.all)}</option>
          <option value="movie">{intl.formatMessage(messages.movies)}</option>
          <option value="tv">{intl.formatMessage(messages.series)}</option>
        </select>
      </label>
      {hasPermission(Permission.ADMIN) && (
        <>
          <label className="flex flex-col gap-1 text-sm font-medium text-gray-200">
            {intl.formatMessage(messages.source)}
            <select
              value={source}
              onChange={(event) =>
                setSource(event.target.value as CalendarSource | '')
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
              checked={is4k}
              onChange={(event) => setIs4k(event.target.checked)}
              type="checkbox"
              className="rounded border-gray-500 bg-gray-800 text-indigo-500 focus:ring-indigo-500"
            />
            {intl.formatMessage(messages.include4k)}
          </label>
        </>
      )}
    </div>
  );

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
        {filters}
        <Button
          className="mt-6 w-full"
          buttonType="primary"
          onClick={() => setFiltersOpen(false)}
        >
          {intl.formatMessage(messages.view)}
        </Button>
      </SlideOver>
      <CalendarDetails
        item={selectedItem}
        onClose={() => setSelectedItem(null)}
      />
    </>
  );

  function EmptyCalendar() {
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
  }
};

const CalendarSkeleton = ({ view, label }: { view: View; label: string }) => (
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

const MonthView = ({
  anchorDate,
  items,
  onSelect,
}: {
  anchorDate: Date;
  items: CalendarItem[];
  onSelect: (item: CalendarItem) => void;
}) => {
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
                    onClick={() => onSelect(dayItems[3])}
                    className="w-full text-left text-xs text-indigo-300 hover:text-indigo-100"
                  >
                    {intl.formatMessage(messages.nextMore, {
                      title: dayItems[3].title,
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

const CalendarChip = ({
  item,
  onClick,
}: {
  item: CalendarItem;
  onClick: () => void;
}) => (
  <button
    onClick={onClick}
    className={`block w-full truncate rounded px-1.5 py-1 text-left text-xs font-medium ${item.available ? 'bg-green-500/20 text-green-200' : item.changeKind === 'delayed' ? 'bg-yellow-500/20 text-yellow-100' : 'bg-indigo-500/20 text-indigo-100'} `}
  >
    {item.mediaType === 'movie' ? '🎬 ' : '📺 '}
    {item.title}
  </button>
);

const CalendarCard = ({
  item,
  onClick,
}: {
  item: CalendarItem;
  onClick: () => void;
}) => {
  const intl = useIntl();
  const date = toLocalDate(item.startsAt, item.allDay);
  const today = startOfDay(new Date());
  const difference = Math.ceil(
    (startOfDay(date).getTime() - today.getTime()) / 86400000
  );
  const episode = formatEpisode(item, intl);
  return (
    <button
      onClick={onClick}
      className="group flex w-full gap-3 rounded-lg border border-gray-700 bg-gray-800/70 p-3 text-left transition hover:border-gray-500 hover:bg-gray-800"
    >
      <div className="relative h-20 w-14 flex-none overflow-hidden rounded bg-gray-700">
        {item.posterPath ? (
          <CachedImage
            src={item.posterPath}
            type="tmdb"
            alt=""
            fill
            sizes="56px"
            className="object-cover"
          />
        ) : item.mediaType === 'movie' ? (
          <FilmIcon className="m-4 h-6 w-6 text-gray-500" />
        ) : (
          <TvIcon className="m-4 h-6 w-6 text-gray-500" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex gap-2">
          <h3 className="truncate font-semibold text-white group-hover:text-indigo-200">
            {item.title}
          </h3>
          {item.is4k ? <Badge badgeType="light">4K</Badge> : null}
        </div>
        <p className="truncate text-sm text-gray-400">
          {[episode, item.subtitle].filter(Boolean).join(' · ') ||
            (item.mediaType === 'movie'
              ? intl.formatMessage(messages.movies)
              : intl.formatMessage(messages.series))}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Badge badgeType="dark">{getDateBadge(item.dateType, intl)}</Badge>
          {item.requestedByCurrentUser ? (
            <Badge>{intl.formatMessage(messages.requested)}</Badge>
          ) : null}
          {item.available ? (
            <Badge badgeType="success">
              {intl.formatMessage(messages.available)}
            </Badge>
          ) : null}
          <ChangeBadge item={item} />
        </div>
      </div>
      <div className="flex flex-col items-end gap-1 text-right text-xs text-gray-400">
        <span>
          {item.allDay
            ? intl.formatDate(date, { month: 'short', day: 'numeric' })
            : intl.formatTime(date, { hour: 'numeric', minute: '2-digit' })}
        </span>
        {difference >= 0 && difference <= 30 ? (
          <span className="font-medium text-indigo-300">
            {difference === 0
              ? intl.formatMessage(messages.todayCountdown)
              : intl.formatMessage(messages.countdown, { count: difference })}
          </span>
        ) : null}
      </div>
    </button>
  );
};

const ChangeBadge = ({ item }: { item: CalendarItem }) => {
  const intl = useIntl();
  if (item.isNewSeason)
    return (
      <Badge badgeType="primary">
        {intl.formatMessage(messages.newSeason)}
      </Badge>
    );
  if (item.changeKind === 'announced')
    return (
      <Badge badgeType="primary">
        {intl.formatMessage(messages.announced)}
      </Badge>
    );
  if (item.changeKind === 'delayed')
    return (
      <Badge badgeType="warning">{intl.formatMessage(messages.delayed)}</Badge>
    );
  if (item.changeKind === 'moved_earlier')
    return (
      <Badge badgeType="success">
        {intl.formatMessage(messages.movedEarlier)}
      </Badge>
    );
  if (item.changeKind === 'withdrawn')
    return (
      <Badge badgeType="warning">
        {intl.formatMessage(messages.withdrawn)}
      </Badge>
    );
  return null;
};

const CalendarDetails = ({
  item,
  onClose,
}: {
  item: CalendarItem | null;
  onClose: () => void;
}) => {
  const intl = useIntl();
  if (!item) return null;
  const episode = formatEpisode(item, intl);
  return (
    <SlideOver
      show
      title={item.title}
      subText={[episode, item.subtitle].filter(Boolean).join(' · ')}
      onClose={onClose}
    >
      <div className="space-y-5">
        <div className="flex gap-3">
          {item.posterPath ? (
            <div className="relative h-28 w-20 flex-none overflow-hidden rounded bg-gray-700">
              <CachedImage
                src={item.posterPath}
                type="tmdb"
                alt=""
                fill
                sizes="80px"
                className="object-cover"
              />
            </div>
          ) : null}
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              <Badge badgeType="dark">
                {getDateBadge(item.dateType, intl)}
              </Badge>
              {item.requestedByCurrentUser ? (
                <Badge>{intl.formatMessage(messages.requested)}</Badge>
              ) : null}
              {item.available ? (
                <Badge badgeType="success">
                  {intl.formatMessage(messages.available)}
                </Badge>
              ) : null}
              <ChangeBadge item={item} />
            </div>
            <p className="text-sm text-gray-300">
              {item.allDay
                ? intl.formatDate(toLocalDate(item.startsAt, true), {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                  })
                : intl.formatDate(toLocalDate(item.startsAt), {
                    weekday: 'long',
                    month: 'long',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
            </p>
            {item.requestedQuality ? (
              <p className="text-xs text-gray-400">
                {intl.formatMessage(messages.requestedQuality, {
                  quality: item.requestedQuality.toUpperCase(),
                })}
              </p>
            ) : null}
          </div>
        </div>
        {item.previousStartsAt ? (
          <Alert
            type="info"
            title={
              item.changeKind === 'delayed'
                ? intl.formatMessage(messages.delayed)
                : intl.formatMessage(messages.movedEarlier)
            }
          >
            {intl.formatMessage(messages.previousDate, {
              date: intl.formatDate(
                toLocalDate(item.previousStartsAt, item.allDay),
                { month: 'short', day: 'numeric', year: 'numeric' }
              ),
            })}
          </Alert>
        ) : null}
        {item.dates?.length ? (
          <div>
            <h3 className="mb-2 text-sm font-semibold text-gray-200">
              {intl.formatMessage(messages.allKnownDates)}
            </h3>
            <ul className="space-y-2">
              {item.dates.map((date) => (
                <li
                  key={`${date.dateType}-${date.startsAt}`}
                  className="flex items-center justify-between rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm"
                >
                  <span className="text-gray-300">
                    {getDateBadge(date.dateType, intl)}
                  </span>
                  <span className="text-white">
                    {date.allDay
                      ? intl.formatDate(toLocalDate(date.startsAt, true), {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })
                      : intl.formatDate(toLocalDate(date.startsAt), {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {item.detailUrl ? (
            <Button as="a" href={item.detailUrl} buttonType="primary">
              {intl.formatMessage(
                item.isNewSeason && !item.requestedByCurrentUser
                  ? messages.requestSeason
                  : messages.details
              )}
            </Button>
          ) : null}
          {item.watchUrl && item.available ? (
            <Button as="a" href={item.watchUrl} buttonType="success">
              <PlayIcon className="mr-1 h-4 w-4" />
              {intl.formatMessage(messages.watch)}
            </Button>
          ) : null}
          {item.sourceUrl ? (
            <Button
              as="a"
              href={item.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ClockIcon className="mr-1 h-4 w-4" />
              {item.source === 'radarr' ? 'Radarr' : 'Sonarr'}
            </Button>
          ) : null}
        </div>
        {!item.dates?.length &&
        !item.detailUrl &&
        !item.watchUrl &&
        !item.sourceUrl ? (
          <p className="text-sm text-gray-400">
            {intl.formatMessage(messages.noDetails)}
          </p>
        ) : null}
      </div>
    </SlideOver>
  );
};

export default Calendar;
