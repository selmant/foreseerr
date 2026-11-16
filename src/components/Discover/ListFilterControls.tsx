import Button from '@app/components/Common/Button';
import type {
  SortGroup,
  SortKind,
  SortMenuGroup,
} from '@app/components/Discover/listSort';
import { directionMessageKey } from '@app/components/Discover/listSort';
import useDebouncedState from '@app/hooks/useDebouncedState';
import defineMessages from '@app/utils/defineMessages';
import {
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
} from '@headlessui/react';
import {
  ArrowsUpDownIcon,
  BarsArrowDownIcon,
  CheckIcon,
  ChevronDownIcon,
  MagnifyingGlassIcon,
} from '@heroicons/react/24/outline';
import { FunnelIcon } from '@heroicons/react/24/solid';
import type { KeyboardEvent, ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';

/** Strings the MDBList, Trakt and AniList list filters share. */
export const listFilterMessages = defineMessages(
  'components.Discover.ListFilterControls',
  {
    sort: 'Sort',
    listOrder: 'List Order',
    contentType: 'Content Type',
    search: 'Search This List',
    searchPlaceholder: 'Search this list…',
    filters: 'Filters',
    activeFilters:
      '{count, plural, =0 {No active filters} one {# active filter} other {# active filters}}',
    clearFilters: 'Clear Filters',
    visibility: 'Visibility',
    hideUnmapped: 'Hide Unmapped Titles',
    hideUnmappedTip: 'Hide titles that could not be mapped to TMDB.',
    genres: 'Genres',
    releaseYear: 'Release Year',
    rangeText: '{minValue} to {maxValue}',
    vipBadge: 'VIP',
    vipOnly: 'Needs Trakt VIP',
    sortDirection: 'Sort direction: {direction}. Select to reverse.',
    topFirst: 'Top first',
    bottomFirst: 'Bottom first',
    aToZ: 'A → Z',
    zToA: 'Z → A',
    oldestFirst: 'Oldest first',
    newestFirst: 'Newest first',
    lowestFirst: 'Lowest first',
    highestFirst: 'Highest first',
    groupList: 'List',
    groupRelease: 'Release',
    groupRatings: 'Ratings',
    groupPopularity: 'Popularity & Votes',
    groupDetails: 'Details',
    groupActivity: 'Your Activity',
  }
);

const groupMessages: Record<SortGroup, keyof typeof listFilterMessages> = {
  list: 'groupList',
  release: 'groupRelease',
  ratings: 'groupRatings',
  popularity: 'groupPopularity',
  details: 'groupDetails',
  activity: 'groupActivity',
};

/**
 * A provider list's sort picker: the same icon-prefixed field as the
 * Movies and Series pages, opening a menu grouped like the provider's own.
 * `selectedLabel` names the current sort even when the menu hides it (a
 * sort from an older link, or one that does not fit the content type).
 */
export const SortMenu = <T extends string>({
  id,
  value,
  groups,
  labelFor,
  selectedLabel,
  defaultLabel,
  onChange,
}: {
  id: string;
  value: T | '';
  groups: SortMenuGroup<T>[];
  labelFor: (value: T) => string;
  selectedLabel: string;
  /** The "no sort" entry (the list's own order); omitted when none. */
  defaultLabel?: string;
  onChange: (value: T | '') => void;
}) => {
  const intl = useIntl();
  const optionClass =
    'group relative flex min-h-[44px] cursor-default select-none items-center gap-2 py-2 pl-9 pr-3 text-sm text-gray-200 data-[disabled]:cursor-not-allowed data-[focus]:bg-indigo-600 data-[focus]:text-white data-[disabled]:opacity-50';
  const check = (
    <CheckIcon
      aria-hidden="true"
      className="invisible absolute left-2.5 h-5 w-5 text-indigo-400 group-data-[selected]:visible group-data-[focus]:text-white"
    />
  );

  return (
    <Listbox value={value} onChange={onChange}>
      <div className="relative flex min-w-0 flex-1">
        <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100">
          <BarsArrowDownIcon aria-hidden="true" className="h-6 w-6" />
        </span>
        <ListboxButton
          id={id}
          aria-label={`${intl.formatMessage(listFilterMessages.sort)}: ${selectedLabel}`}
          className="relative flex min-h-[44px] w-full min-w-0 items-center rounded-r-md border border-gray-500 bg-gray-700 py-2 pl-3 pr-9 text-left text-sm text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
        >
          <span className="block truncate">{selectedLabel}</span>
          <ChevronDownIcon
            aria-hidden="true"
            className="pointer-events-none absolute right-2 h-5 w-5 text-gray-400"
          />
        </ListboxButton>
      </div>
      <ListboxOptions
        anchor={{ to: 'bottom start', gap: 6, padding: 8 }}
        className="z-[60] max-h-[min(24rem,70vh)] w-[var(--button-width)] min-w-[16rem] overflow-y-auto rounded-md border border-gray-600 bg-gray-800 py-1 shadow-xl focus:outline-none"
      >
        {defaultLabel && (
          <ListboxOption value="" className={optionClass}>
            {check}
            <span className="truncate">{defaultLabel}</span>
          </ListboxOption>
        )}
        {groups.map(({ group, options }) => (
          <div key={group} role="presentation">
            <div
              role="presentation"
              className="px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-gray-400"
            >
              {intl.formatMessage(listFilterMessages[groupMessages[group]])}
            </div>
            {options.map(({ option, availability }) => (
              <ListboxOption
                key={option.value}
                value={option.value}
                disabled={availability === 'needsVip'}
                className={optionClass}
                title={
                  availability === 'needsVip'
                    ? intl.formatMessage(listFilterMessages.vipOnly)
                    : undefined
                }
              >
                {check}
                <span className="min-w-0 flex-1 truncate">
                  {labelFor(option.value)}
                </span>
                {option.vip && (
                  <span className="shrink-0 rounded bg-gray-700 px-1.5 py-0.5 text-xs font-medium text-yellow-300 group-data-[focus]:bg-indigo-500 group-data-[focus]:text-white">
                    {intl.formatMessage(listFilterMessages.vipBadge)}
                  </span>
                )}
              </ListboxOption>
            ))}
          </div>
        ))}
      </ListboxOptions>
    </Listbox>
  );
};

/**
 * Flips a sort's direction. The label says what the order means for this
 * sort ("Newest first", "A → Z") rather than "ascending".
 */
export const SortDirectionButton = ({
  kind,
  order,
  onChange,
}: {
  kind: SortKind;
  order: 'asc' | 'desc';
  onChange: (order: 'asc' | 'desc') => void;
}) => {
  const intl = useIntl();
  const direction = intl.formatMessage(
    listFilterMessages[directionMessageKey(kind, order)]
  );
  return (
    <Button
      className="min-h-[44px] shrink-0 whitespace-nowrap"
      aria-label={intl.formatMessage(listFilterMessages.sortDirection, {
        direction,
      })}
      onClick={() => onChange(order === 'asc' ? 'desc' : 'asc')}
    >
      <ArrowsUpDownIcon aria-hidden="true" />
      <span>{direction}</span>
    </Button>
  );
};

/** Opens a list's filter panel; the badge counts what the panel narrows. */
export const FilterButton = ({
  count,
  expanded,
  onClick,
}: {
  count: number;
  expanded: boolean;
  onClick: () => void;
}) => {
  const intl = useIntl();
  return (
    <Button
      onClick={onClick}
      className="min-h-[44px] shrink-0"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={`${intl.formatMessage(listFilterMessages.filters)}, ${intl.formatMessage(listFilterMessages.activeFilters, { count })}`}
    >
      <FunnelIcon aria-hidden="true" />
      <span>{intl.formatMessage(listFilterMessages.filters)}</span>
      {count > 0 && (
        <span
          aria-hidden="true"
          className="ml-1 inline-flex min-w-[1.5rem] items-center justify-center rounded-full bg-indigo-600 px-1.5 text-xs font-semibold leading-6 text-white"
        >
          {count}
        </span>
      )}
    </Button>
  );
};

/**
 * The toolbar for a list's title: one row below the title (two on phones),
 * and on the title's line only on very wide screens, where long list names
 * still have room.
 */
export const ListFilterHeader = ({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) => (
  <div className="mb-5 mt-1 flex flex-col gap-3 2xl:flex-row 2xl:items-end 2xl:justify-between 2xl:gap-6 [&_h2]:whitespace-normal [&_h2]:break-words">
    <div className="min-w-0 flex-1 space-y-2">{title}</div>
    <div className="flex w-full flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center 2xl:w-auto 2xl:max-w-[46rem] 2xl:flex-nowrap 2xl:justify-end">
      {children}
    </div>
  </div>
);

/** A row of toggle chips, one or many picked, like a provider's sidebar. */
export const ChipGroup = <T extends string>({
  label,
  options,
  selected,
  onChange,
  multiple = true,
  disabled = false,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  selected: readonly T[];
  onChange: (selected: T[]) => void;
  multiple?: boolean;
  disabled?: boolean;
}) => {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // Radio groups move with the arrow keys and keep one tab stop.
  const focusIndex = Math.max(
    0,
    options.findIndex((o) => selected.includes(o.value))
  );
  const onKeyDown = (event: KeyboardEvent, index: number) => {
    if (multiple) return;
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + options.length) % options.length;
    onChange([options[next].value]);
    refs.current[next]?.focus();
  };

  return (
    <div
      className="flex flex-wrap gap-2"
      role={multiple ? 'group' : 'radiogroup'}
      aria-label={label}
    >
      {options.map((option, index) => {
        const active = selected.includes(option.value);
        return (
          <button
            key={option.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role={multiple ? 'checkbox' : 'radio'}
            aria-checked={active}
            tabIndex={multiple || index === focusIndex ? 0 : -1}
            disabled={disabled}
            className={`min-h-[44px] rounded-full border px-4 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50 ${
              active
                ? 'border-indigo-500 bg-indigo-600 text-white'
                : 'border-gray-600 bg-gray-800 text-gray-300 hover:bg-gray-700'
            }`}
            onKeyDown={(event) => onKeyDown(event, index)}
            onClick={() => {
              if (!multiple) {
                onChange(active ? [] : [option.value]);
              } else {
                onChange(
                  active
                    ? selected.filter((v) => v !== option.value)
                    : [...selected, option.value]
                );
              }
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
};

/** A text filter that updates the route once typing pauses. */
export const DebouncedSearchInput = ({
  id,
  value,
  label,
  placeholder,
  onChange,
  className = 'min-h-[44px] w-full',
  withIcon = false,
}: {
  id: string;
  value: string;
  /** Read by screen readers when the field has no visible label. */
  label?: string;
  placeholder?: string;
  onChange: (value?: string) => void;
  className?: string;
  withIcon?: boolean;
}) => {
  const [text, debounced, setText] = useDebouncedState(value, 500);
  const sent = useRef(value);

  // Follow the route when it changes elsewhere (e.g. "Clear").
  useEffect(() => {
    if (value !== sent.current) {
      sent.current = value;
      setText(value);
    }
  }, [value, setText]);

  useEffect(() => {
    const next = debounced.trim();
    if (next !== sent.current) {
      sent.current = next;
      onChange(next || undefined);
    }
  }, [debounced, onChange]);

  const input = (
    <input
      id={id}
      type="search"
      aria-label={label}
      className={withIcon ? `${className} pl-10` : className}
      value={text}
      maxLength={200}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
    />
  );
  if (!withIcon) return input;
  return (
    <div className="relative w-full">
      <MagnifyingGlassIcon
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-gray-400"
      />
      {input}
    </div>
  );
};

export const FilterSectionTitle = ({
  children,
  id,
  value,
}: {
  children: ReactNode;
  id?: string;
  /** Shown at the right, such as a slider's current range. */
  value?: ReactNode;
}) => (
  <div className="mb-2 flex items-baseline justify-between gap-2">
    <div id={id} className="text-lg font-semibold">
      {children}
    </div>
    {value !== undefined && (
      <span className="text-sm text-gray-400">{value}</span>
    )}
  </div>
);

/** Comma-separated route values. */
export const splitList = (value: unknown): string[] =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    : [];
