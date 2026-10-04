import defineMessages from '@app/utils/defineMessages';
import type { PublicSettingsResponse } from '@server/interfaces/api/settingsInterfaces';

export const sourceMessages = defineMessages('components.Discover.Sources', {
  title: 'Sources',
  description:
    'Explore recommendations, anime, and curated lists in one place.',
  available: 'Integration ready',
  sourceShortcuts: 'Jump to a source',
  accountLinked: 'Account connected',
  connectionNeeded: 'Connection needed',
  checkingConnection: 'Checking connection…',
  connectionError: 'Could not update the account connection status.',
  connectionHint:
    'Review your {source} connection in Linked accounts to use these personal views.',
  reviewConnection: 'Review {source} connection',
  refreshLists: 'Refresh lists',
  savedListsError:
    'Could not update your lists. Your previously loaded lists are still available.',
  publicListHint:
    'Open a public {source} list using its URL, username/list-slug, or list ID. Your account does not need to be linked.',
  notConfigured: 'Not configured',
  configure: 'Set up integration',
  needsAdmin: 'Ask your administrator to enable this source.',
  linkedAccounts: 'Linked accounts',
  personalHint:
    'Link your accounts to unlock your personal lists and watch history.',
  personalViews: 'Your account',
  browseViews: 'Explore',
  openList: 'Open list',
  listUrl: '{source} list URL or username/list-slug',
  customLists: 'Your AniList lists',
  selectList: 'Choose a list',
  listsError: 'Could not load your lists.',
  retry: 'Try again',
  noLists: 'No lists found in your AniList account.',
  loadingLists: 'Loading your lists…',
  traktDescription:
    'Recommendations based on your taste, watch history, and community lists.',
  anilistDescription:
    'Find anime by season, popularity, and rating, or revisit your own lists.',
  simklDescription:
    'Explore trending titles and the movies, series, and anime you track.',
  mdblistDescription:
    'Browse curated public lists with ratings from across the web.',
  recommendations: 'Recommendations',
  watchlist: 'Watchlist',
  history: 'History',
  lists: 'My lists',
  trending: 'Trending',
  season: 'This season',
  popular: 'Popular',
  top: 'Top 100',
  nextSeason: 'Next season',
  watching: 'Watching',
  planning: 'Plan to watch',
  completed: 'Completed',
  hold: 'On hold',
  dropped: 'Dropped',
  navigation: '{source} views',
});

export type DiscoverSource = 'trakt' | 'anilist' | 'simkl' | 'mdblist';
export type SourceView = {
  label: keyof typeof sourceMessages;
  href: string;
  personal?: boolean;
};

export const discoverSources: {
  id: DiscoverSource;
  name: string;
  description: keyof typeof sourceMessages;
  setting: keyof Pick<
    PublicSettingsResponse,
    | 'traktConfigured'
    | 'anilistConfigured'
    | 'simklConfigured'
    | 'mdblistConfigured'
  >;
  views: SourceView[];
}[] = [
  {
    id: 'trakt',
    name: 'Trakt',
    description: 'traktDescription',
    setting: 'traktConfigured',
    views: [
      {
        label: 'recommendations',
        href: '/discover/trakt/recommendations',
        personal: true,
      },
      { label: 'watchlist', href: '/discover/trakt/watchlist', personal: true },
      { label: 'history', href: '/discover/trakt/history', personal: true },
      { label: 'lists', href: '/discover/trakt/lists', personal: true },
    ],
  },
  {
    id: 'anilist',
    name: 'AniList',
    description: 'anilistDescription',
    setting: 'anilistConfigured',
    views: [
      { label: 'trending', href: '/discover/anilist/trending' },
      { label: 'season', href: '/discover/anilist/season' },
      { label: 'popular', href: '/discover/anilist/popular' },
      { label: 'top', href: '/discover/anilist/top' },
      { label: 'nextSeason', href: '/discover/anilist/next-season' },
      { label: 'watching', href: '/discover/anilist/watching', personal: true },
      { label: 'planning', href: '/discover/anilist/planning', personal: true },
      {
        label: 'completed',
        href: '/discover/anilist/completed',
        personal: true,
      },
    ],
  },
  {
    id: 'simkl',
    name: 'Simkl',
    description: 'simklDescription',
    setting: 'simklConfigured',
    views: [
      { label: 'trending', href: '/discover/simkl?view=trending' },
      {
        label: 'watching',
        href: '/discover/simkl?status=watching',
        personal: true,
      },
      {
        label: 'planning',
        href: '/discover/simkl?status=plantowatch',
        personal: true,
      },
      { label: 'hold', href: '/discover/simkl?status=hold', personal: true },
      {
        label: 'completed',
        href: '/discover/simkl?status=completed',
        personal: true,
      },
      {
        label: 'dropped',
        href: '/discover/simkl?status=dropped',
        personal: true,
      },
    ],
  },
  {
    id: 'mdblist',
    name: 'MDBList',
    description: 'mdblistDescription',
    setting: 'mdblistConfigured',
    views: [],
  },
];

export const getDiscoverSource = (pathname: string) =>
  discoverSources.find(
    (source) =>
      pathname === `/discover/${source.id}` ||
      pathname.startsWith(`/discover/${source.id}/`)
  );

/** Keep the chosen Simkl content type when moving between watch statuses. */
export const sourceViewHref = (href: string, search: string) => {
  const [path, query] = href.split('?');
  if (path !== '/discover/simkl') return href;
  const current = new URLSearchParams(search);
  const next = new URLSearchParams(query);
  const mediaType = current.get('mediaType');
  if (mediaType === 'movie' || mediaType === 'tv' || mediaType === 'anime') {
    next.set('mediaType', mediaType);
  }
  const period = current.get('period');
  if (
    next.get('view') === 'trending' &&
    (period === 'day' || period === 'month')
  ) {
    next.set('period', period);
  }
  return `${path}?${next}`;
};

export const isSourceViewActive = (
  href: string,
  pathname: string,
  search: string
) => {
  const [path, query] = href.split('?');
  if (path !== pathname) return false;
  if (!query) return true;
  const current = new URLSearchParams(search);
  if (
    pathname === '/discover/simkl' &&
    current.has('view') &&
    new URLSearchParams(query).has('status')
  )
    return false;
  return [...new URLSearchParams(query)].every(
    ([key, value]) =>
      // Simkl opens Plan to Watch when no view or status is specified.
      (current.get(key) ??
        (key === 'status' && !current.has('view') ? 'plantowatch' : null)) ===
      value
  );
};
