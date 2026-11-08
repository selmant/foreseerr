import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import {
  AdjustmentsHorizontalIcon,
  BookmarkIcon,
  CalendarDaysIcon,
  ClockIcon,
  CogIcon,
  ExclamationTriangleIcon,
  EyeSlashIcon,
  InboxArrowDownIcon,
  LinkIcon,
  RectangleStackIcon,
  SparklesIcon,
  UsersIcon,
} from '@heroicons/react/24/outline';
import type { ComponentType, SVGProps } from 'react';

export const menuMessages = defineMessages('components.Layout.Sidebar', {
  dashboard: 'Discover',
  library: 'Library',
  browsemovies: 'Movies',
  browsetv: 'Series',
  requests: 'Requests',
  calendar: 'Calendar',
  blocklist: 'Blocklist',
  issues: 'Issues',
  users: 'Users',
  settings: 'Settings',
  interventions: 'Interventions',
  explore: 'Explore',
  manage: 'Manage',
  account: 'Your account',
  linkedAccounts: 'Linked accounts',
  watchlist: 'Your watchlist',
  preferences: 'Discover preferences',
  navigation: 'Main navigation',
  more: 'More',
  close: 'Close navigation',
});

export type NavigationCounts = {
  pendingRequestsCount: number;
  openIssuesCount: number;
  activeInterventionsCount: number;
};
type MenuKey = keyof typeof menuMessages;
export type NavigationLink = {
  href: string;
  messagesKey: MenuKey;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  activeRegExp: RegExp;
  group: 'explore' | 'manage' | 'account';
  requiredPermission?: Permission | Permission[];
  permissionType?: 'and' | 'or';
  dataTestId?: string;
};

const navigationLinks: NavigationLink[] = [
  {
    href: '/',
    messagesKey: 'dashboard',
    Icon: SparklesIcon,
    activeRegExp: /^\/(?:discover(?:\/.*)?)?$/,
    group: 'explore',
  },
  {
    href: '/library',
    messagesKey: 'library',
    Icon: RectangleStackIcon,
    activeRegExp: /^\/library/,
    group: 'explore',
  },
  {
    href: '/requests',
    messagesKey: 'requests',
    Icon: ClockIcon,
    activeRegExp: /^\/requests/,
    group: 'explore',
  },
  {
    href: '/calendar',
    messagesKey: 'calendar',
    Icon: CalendarDaysIcon,
    activeRegExp: /^\/calendar/,
    group: 'explore',
  },
  {
    href: '/interventions',
    messagesKey: 'interventions',
    Icon: InboxArrowDownIcon,
    activeRegExp: /^\/interventions/,
    group: 'manage',
    requiredPermission: Permission.MANAGE_REQUESTS,
  },
  {
    href: '/blocklist',
    messagesKey: 'blocklist',
    Icon: EyeSlashIcon,
    activeRegExp: /^\/blocklist/,
    group: 'manage',
    requiredPermission: [
      Permission.MANAGE_BLOCKLIST,
      Permission.VIEW_BLOCKLIST,
    ],
    permissionType: 'or',
  },
  {
    href: '/issues',
    messagesKey: 'issues',
    Icon: ExclamationTriangleIcon,
    activeRegExp: /^\/issues/,
    group: 'manage',
    requiredPermission: [
      Permission.MANAGE_ISSUES,
      Permission.CREATE_ISSUES,
      Permission.VIEW_ISSUES,
    ],
    permissionType: 'or',
  },
  {
    href: '/users',
    messagesKey: 'users',
    Icon: UsersIcon,
    activeRegExp: /^\/users/,
    group: 'manage',
    requiredPermission: Permission.MANAGE_USERS,
    dataTestId: 'sidebar-menu-users',
  },
  {
    href: '/settings',
    messagesKey: 'settings',
    Icon: CogIcon,
    activeRegExp: /^\/settings/,
    group: 'manage',
    requiredPermission: Permission.ADMIN,
    dataTestId: 'sidebar-menu-settings',
  },
  {
    href: '/profile/watchlist',
    messagesKey: 'watchlist',
    Icon: BookmarkIcon,
    activeRegExp: /^\/profile\/watchlist/,
    group: 'account',
  },
  {
    href: '/profile/settings/linked-accounts',
    messagesKey: 'linkedAccounts',
    Icon: LinkIcon,
    activeRegExp: /^\/profile\/settings\/linked-accounts/,
    group: 'account',
  },
  {
    href: '/profile/settings/discover',
    messagesKey: 'preferences',
    Icon: AdjustmentsHorizontalIcon,
    activeRegExp: /^\/profile\/settings\/discover/,
    group: 'account',
  },
];

/** Shared destinations and permissions keep desktop and mobile navigation in sync. */
export const useAppNavigation = (counts: NavigationCounts) => {
  const { hasPermission } = useUser();
  return navigationLinks
    .filter(
      (link) =>
        !link.requiredPermission ||
        hasPermission(link.requiredPermission, {
          type: link.permissionType ?? 'and',
        })
    )
    .map((link) => ({
      ...link,
      count:
        link.messagesKey === 'requests' &&
        hasPermission(Permission.MANAGE_REQUESTS)
          ? counts.pendingRequestsCount
          : link.messagesKey === 'issues' &&
              hasPermission(Permission.MANAGE_ISSUES)
            ? counts.openIssuesCount
            : link.messagesKey === 'interventions'
              ? counts.activeInterventionsCount
              : 0,
    }));
};
