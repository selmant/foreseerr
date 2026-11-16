/**
 * Sort menus for provider lists (MDBList, Trakt, AniList): which sorts to
 * offer, grouped like the providers' own menus, and how to word the
 * direction for each. Kept free of React so the rules are unit-tested.
 */

/** What a sort orders by, which decides how its direction reads. */
export type SortKind = 'position' | 'alpha' | 'date' | 'number';

/** Menu sections, in display order. */
export const sortGroups = [
  'list',
  'release',
  'ratings',
  'popularity',
  'details',
  'activity',
] as const;

export type SortGroup = (typeof sortGroups)[number];

export type ListSortOption<T extends string> = {
  value: T;
  kind: SortKind;
  group: SortGroup;
  /** Only meaningful for movies (budget) or shows (last air date). */
  only?: 'movie' | 'tv';
  /** Trakt applies it only for VIP accounts. */
  vip?: boolean;
  /** Reads the viewer's own Trakt activity, so it needs a linked account. */
  personal?: boolean;
  /** Still accepted from links, but left out of the menu (a duplicate). */
  hidden?: boolean;
};

export type SortContext = {
  /** The list's content type; undefined shows sorts for both. */
  mediaType?: 'movie' | 'tv';
  /** Whether the viewer's account is linked (Trakt). */
  linked?: boolean;
  /** Trakt VIP; null or undefined when unknown. */
  vip?: boolean | null;
};

export type SortAvailability = 'available' | 'needsVip';

/**
 * Whether a sort belongs in the menu for this context, and if so whether
 * it can be picked. Unknown VIP status keeps VIP sorts pickable.
 */
export const sortAvailability = <T extends string>(
  option: ListSortOption<T>,
  context: SortContext = {}
): SortAvailability | null => {
  if (option.hidden) return null;
  if (option.only && context.mediaType && option.only !== context.mediaType) {
    return null;
  }
  if (option.personal && context.linked === false) return null;
  if (option.vip && context.vip === false) return 'needsVip';
  return 'available';
};

export type SortMenuGroup<T extends string> = {
  group: SortGroup;
  options: { option: ListSortOption<T>; availability: SortAvailability }[];
};

/** The menu's sections, empty ones dropped, in `sortGroups` order. */
export const groupSorts = <T extends string>(
  options: readonly ListSortOption<T>[],
  context: SortContext = {}
): SortMenuGroup<T>[] =>
  sortGroups
    .map((group) => ({
      group,
      options: options.flatMap((option) => {
        if (option.group !== group) return [];
        const availability = sortAvailability(option, context);
        return availability ? [{ option, availability }] : [];
      }),
    }))
    .filter((section) => section.options.length > 0);

/** Positions and names read top-down / A→Z; dates and numbers high→low. */
export const defaultOrderForKind = (kind: SortKind): 'asc' | 'desc' =>
  kind === 'position' || kind === 'alpha' ? 'asc' : 'desc';

/** The message key for a direction, worded for what the sort orders by. */
export const directionMessageKey = (
  kind: SortKind,
  order: 'asc' | 'desc'
):
  | 'topFirst'
  | 'bottomFirst'
  | 'aToZ'
  | 'zToA'
  | 'oldestFirst'
  | 'newestFirst'
  | 'lowestFirst'
  | 'highestFirst' => {
  switch (kind) {
    case 'position':
      return order === 'asc' ? 'topFirst' : 'bottomFirst';
    case 'alpha':
      return order === 'asc' ? 'aToZ' : 'zToA';
    case 'date':
      return order === 'asc' ? 'oldestFirst' : 'newestFirst';
    case 'number':
      return order === 'asc' ? 'lowestFirst' : 'highestFirst';
  }
};

/**
 * Whether a content-type change leaves the current sort meaningless (a
 * movie-only sort on shows), so the bar should drop it with the type.
 */
export const sortDroppedByMediaType = <T extends string>(
  options: readonly ListSortOption<T>[],
  sort: string | undefined,
  mediaType: 'movie' | 'tv' | undefined
): boolean => {
  const option = options.find((o) => o.value === sort);
  return Boolean(option?.only && mediaType && option.only !== mediaType);
};
