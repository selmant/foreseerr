import AppImage from '@app/components/Common/AppImage';
import Badge from '@app/components/Common/Badge';
import QuitAppControl from '@app/components/Layout/QuitAppControl';
import VersionStatus from '@app/components/Layout/VersionStatus';
import useClickOutside from '@app/hooks/useClickOutside';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import {
  CalendarDaysIcon,
  ClockIcon,
  CogIcon,
  ExclamationTriangleIcon,
  EyeSlashIcon,
  InboxArrowDownIcon,
  RectangleStackIcon,
  SparklesIcon,
  UsersIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { Fragment, useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';
import { Link, useLocation } from 'react-router';

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
});

interface SidebarProps {
  open?: boolean;
  setClosed: () => void;
  pendingRequestsCount: number;
  openIssuesCount: number;
  activeInterventionsCount: number;
  revalidateIssueCount: () => void;
  revalidateRequestsCount: () => void;
}

interface SidebarLinkProps {
  href: string;
  svgIcon: React.ReactNode;
  messagesKey: keyof typeof menuMessages;
  activeRegExp: RegExp;
  as?: string;
  requiredPermission?: Permission | Permission[];
  permissionType?: 'and' | 'or';
  dataTestId?: string;
}

const SidebarLinks: SidebarLinkProps[] = [
  {
    href: '/',
    messagesKey: 'dashboard',
    svgIcon: <SparklesIcon className="mr-3 h-6 w-6" />,
    activeRegExp: /^\/(?:discover(?:\/.*)?)?$/,
  },
  {
    href: '/library',
    messagesKey: 'library',
    svgIcon: <RectangleStackIcon className="mr-3 h-6 w-6" />,
    activeRegExp: /^\/library/,
  },
  {
    href: '/requests',
    messagesKey: 'requests',
    svgIcon: <ClockIcon className="mr-3 h-6 w-6" />,
    activeRegExp: /^\/requests/,
  },
  {
    href: '/calendar',
    messagesKey: 'calendar',
    svgIcon: <CalendarDaysIcon className="mr-3 h-6 w-6" />,
    activeRegExp: /^\/calendar/,
  },
  {
    href: '/interventions',
    messagesKey: 'interventions',
    svgIcon: <InboxArrowDownIcon className="mr-3 h-6 w-6" />,
    activeRegExp: /^\/interventions/,
    requiredPermission: Permission.MANAGE_REQUESTS,
  },
  {
    href: '/blocklist',
    messagesKey: 'blocklist',
    svgIcon: <EyeSlashIcon className="mr-3 h-6 w-6" />,
    activeRegExp: /^\/blocklist/,
    requiredPermission: [
      Permission.MANAGE_BLOCKLIST,
      Permission.VIEW_BLOCKLIST,
    ],
    permissionType: 'or',
  },
  {
    href: '/issues',
    messagesKey: 'issues',
    svgIcon: <ExclamationTriangleIcon className="mr-3 h-6 w-6" />,
    activeRegExp: /^\/issues/,
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
    svgIcon: <UsersIcon className="mr-3 h-6 w-6" />,
    activeRegExp: /^\/users/,
    requiredPermission: Permission.MANAGE_USERS,
    dataTestId: 'sidebar-menu-users',
  },
  {
    href: '/settings',
    messagesKey: 'settings',
    svgIcon: <CogIcon className="mr-3 h-6 w-6" />,
    activeRegExp: /^\/settings/,
    requiredPermission: Permission.ADMIN,
    dataTestId: 'sidebar-menu-settings',
  },
];

const Sidebar = ({
  open,
  setClosed,
  pendingRequestsCount,
  openIssuesCount,
  activeInterventionsCount,
  revalidateIssueCount,
  revalidateRequestsCount,
}: SidebarProps) => {
  const navRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const intl = useIntl();
  const { hasPermission } = useUser();
  useClickOutside(navRef, () => setClosed());

  useEffect(() => {
    if (openIssuesCount) {
      revalidateIssueCount();
    }

    if (pendingRequestsCount) {
      revalidateRequestsCount();
    }
  }, [
    revalidateIssueCount,
    revalidateRequestsCount,
    pendingRequestsCount,
    openIssuesCount,
  ]);

  return (
    <>
      <div className="lg:hidden">
        <Transition as={Fragment} show={open}>
          <div className="fixed inset-0 z-40 flex">
            <Transition.Child
              as="div"
              enter="transition-opacity ease-linear duration-300"
              enterFrom="opacity-0"
              enterTo="opacity-100"
              leave="transition-opacity ease-linear duration-300"
              leaveFrom="opacity-100"
              leaveTo="opacity-0"
            >
              <div className="fixed inset-0">
                <div className="absolute inset-0 bg-gray-900 opacity-90" />
              </div>
            </Transition.Child>
            <Transition.Child
              as="div"
              enter="transition-transform ease-in-out duration-300"
              enterFrom="-translate-x-full"
              enterTo="translate-x-0"
              leave="transition-transform ease-in-out duration-300"
              leaveFrom="translate-x-0"
              leaveTo="-translate-x-full"
            >
              <>
                <div className="sidebar relative flex h-full w-full max-w-xs flex-1 flex-col bg-gray-800">
                  <div className="sidebar-close-button absolute right-0 -mr-14 p-1">
                    <button
                      className="flex h-12 w-12 items-center justify-center rounded-full focus:bg-gray-600 focus:outline-none"
                      aria-label="Close sidebar"
                      onClick={() => setClosed()}
                    >
                      <XMarkIcon className="h-6 w-6 text-white" />
                    </button>
                  </div>
                  <div
                    ref={navRef}
                    className="flex flex-1 flex-col overflow-y-auto pb-8 pt-4 sm:pb-4"
                  >
                    <div className="flex flex-shrink-0 items-center px-2">
                      <span className="w-full px-4 text-xl text-gray-50">
                        <Link to="/" className="relative block h-24 w-64">
                          <AppImage src="/logo_full.svg" alt="Logo" fill />
                        </Link>
                      </span>
                    </div>
                    <nav className="mt-10 flex-1 space-y-4 px-4">
                      {SidebarLinks.filter((link) =>
                        link.requiredPermission
                          ? hasPermission(link.requiredPermission, {
                              type: link.permissionType ?? 'and',
                            })
                          : true
                      ).map((sidebarLink) => {
                        return (
                          <Link
                            key={`mobile-${sidebarLink.messagesKey}`}
                            to={sidebarLink.href}
                            onClick={() => setClosed()}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                setClosed();
                              }
                            }}
                            role="button"
                            tabIndex={0}
                            className={`flex items-center rounded-md px-2 py-2 text-base font-medium leading-6 text-white transition duration-150 ease-in-out focus:outline-none ${
                              location.pathname.match(sidebarLink.activeRegExp)
                                ? 'bg-gradient-to-br from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500'
                                : 'hover:bg-gray-700 focus:bg-gray-700'
                            } `}
                            data-testid={`${sidebarLink.dataTestId}-mobile`}
                          >
                            {sidebarLink.svgIcon}
                            {intl.formatMessage(
                              menuMessages[sidebarLink.messagesKey]
                            )}
                          </Link>
                        );
                      })}
                    </nav>
                    <div className="mt-auto space-y-2 px-4">
                      <QuitAppControl />
                      {hasPermission(Permission.ADMIN) && (
                        <VersionStatus onClick={() => setClosed()} />
                      )}
                    </div>
                  </div>
                </div>
                <div className="w-14 flex-shrink-0">
                  {/* <!-- Force sidebar to shrink to fit close icon --> */}
                </div>
              </>
            </Transition.Child>
          </div>
        </Transition>
      </div>

      <div className="fixed bottom-0 left-0 top-0 z-30 hidden lg:flex lg:flex-shrink-0">
        <div className="sidebar flex w-64 flex-col">
          <div className="flex h-0 flex-1 flex-col">
            <div className="flex flex-1 flex-col overflow-y-auto pb-4">
              <div className="flex flex-shrink-0 items-center">
                <span className="w-full px-4 py-2 text-2xl text-gray-50">
                  <Link to="/" className="relative block h-24">
                    <AppImage
                      src="/logo_full.svg"
                      alt="Logo"
                      fill
                      loading="eager"
                    />
                  </Link>
                </span>
              </div>
              <nav className="mt-8 flex-1 space-y-4 px-4">
                {SidebarLinks.filter((link) =>
                  link.requiredPermission
                    ? hasPermission(link.requiredPermission, {
                        type: link.permissionType ?? 'and',
                      })
                    : true
                ).map((sidebarLink) => {
                  return (
                    <Link
                      key={`desktop-${sidebarLink.messagesKey}`}
                      to={sidebarLink.href}
                      className={`group flex items-center rounded-md px-2 py-2 text-lg font-medium leading-6 text-white transition duration-150 ease-in-out focus:outline-none ${
                        location.pathname.match(sidebarLink.activeRegExp)
                          ? 'bg-gradient-to-br from-indigo-600 to-purple-600 hover:from-indigo-500 hover:to-purple-500'
                          : 'hover:bg-gray-700 focus:bg-gray-700'
                      } `}
                      data-testid={sidebarLink.dataTestId}
                    >
                      {sidebarLink.svgIcon}
                      {intl.formatMessage(
                        menuMessages[sidebarLink.messagesKey]
                      )}
                      {sidebarLink.messagesKey === 'requests' &&
                        pendingRequestsCount > 0 &&
                        hasPermission(Permission.MANAGE_REQUESTS) && (
                          <div className="ml-auto flex">
                            <Badge
                              className={`rounded-md bg-gradient-to-br ${
                                location.pathname.match(
                                  sidebarLink.activeRegExp
                                )
                                  ? 'border-indigo-600 from-indigo-700 to-purple-700'
                                  : 'border-indigo-500 from-indigo-600 to-purple-600'
                              }`}
                            >
                              {pendingRequestsCount}
                            </Badge>
                          </div>
                        )}
                      {sidebarLink.messagesKey === 'issues' &&
                        openIssuesCount > 0 &&
                        hasPermission(Permission.MANAGE_ISSUES) && (
                          <div className="ml-auto flex">
                            <Badge
                              className={`rounded-md bg-gradient-to-br ${
                                location.pathname.match(
                                  sidebarLink.activeRegExp
                                )
                                  ? 'border-indigo-600 from-indigo-700 to-purple-700'
                                  : 'border-indigo-500 from-indigo-600 to-purple-600'
                              }`}
                            >
                              {openIssuesCount}
                            </Badge>
                          </div>
                        )}
                      {sidebarLink.messagesKey === 'interventions' &&
                        activeInterventionsCount > 0 && (
                          <div className="ml-auto flex">
                            <Badge className="rounded-md border-yellow-500 bg-yellow-600">
                              {activeInterventionsCount}
                            </Badge>
                          </div>
                        )}
                    </Link>
                  );
                })}
              </nav>
              <div className="mt-auto space-y-2 px-4">
                <QuitAppControl />
                {hasPermission(Permission.ADMIN) && <VersionStatus />}
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default Sidebar;
