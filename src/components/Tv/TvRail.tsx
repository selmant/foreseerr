import TvFocusable from '@app/components/Tv/TvFocusable';
import defineMessages from '@app/utils/defineMessages';
import {
  ClockIcon,
  Cog6ToothIcon,
  MagnifyingGlassIcon,
  RectangleStackIcon,
  SparklesIcon,
} from '@heroicons/react/24/outline';
import type { Ref } from 'react';
import { useIntl } from 'react-intl';
import { NavLink, useLocation } from 'react-router';

const messages = defineMessages('components.Tv.TvRail', {
  home: 'Home',
  library: 'Library',
  search: 'Search',
  requests: 'Requests',
  account: 'Account',
});

const items = [
  {
    href: '/',
    messagesKey: 'home' as const,
    icon: SparklesIcon,
    match: (path: string) => path === '/' || path.startsWith('/discover'),
  },
  {
    href: '/library',
    messagesKey: 'library' as const,
    icon: RectangleStackIcon,
    match: (path: string) => path.startsWith('/library'),
  },
  {
    href: '/search',
    messagesKey: 'search' as const,
    icon: MagnifyingGlassIcon,
    match: (path: string) => path.startsWith('/search'),
  },
  {
    href: '/requests',
    messagesKey: 'requests' as const,
    icon: ClockIcon,
    match: (path: string) => path.startsWith('/requests'),
  },
  {
    href: '/profile/settings',
    messagesKey: 'account' as const,
    icon: Cog6ToothIcon,
    match: (path: string) => path.startsWith('/profile'),
  },
];

const TvRail = () => {
  const intl = useIntl();
  const location = useLocation();

  return (
    <nav
      aria-label="TV"
      className="flex w-28 shrink-0 flex-col gap-2 border-r border-gray-800 bg-gray-950/80 py-6"
    >
      {items.map((item) => {
        const Icon = item.icon;
        const active = item.match(location.pathname);
        return (
          <TvFocusable key={item.href} focusKey={`TV_RAIL_${item.messagesKey}`}>
            {({ ref, className }) => (
              <NavLink
                ref={ref as Ref<HTMLAnchorElement>}
                to={item.href}
                className={[
                  'mx-2 flex min-h-14 flex-col items-center justify-center rounded-lg px-2 py-2 text-xs font-medium',
                  active ? 'bg-indigo-600/80 text-white' : 'text-gray-300',
                  className,
                ].join(' ')}
              >
                <Icon className="mb-1 h-7 w-7" />
                {intl.formatMessage(messages[item.messagesKey])}
              </NavLink>
            )}
          </TvFocusable>
        );
      })}
    </nav>
  );
};

export default TvRail;
