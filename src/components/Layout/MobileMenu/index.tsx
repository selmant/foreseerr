import Badge from '@app/components/Common/Badge';
import QuitAppControl from '@app/components/Layout/QuitAppControl';
import { menuMessages } from '@app/components/Layout/Sidebar';
import useClickOutside from '@app/hooks/useClickOutside';
import { Permission, useUser } from '@app/hooks/useUser';
import { Transition } from '@headlessui/react';
import {
  CalendarDaysIcon,
  ClockIcon,
  CogIcon,
  EllipsisHorizontalIcon,
  ExclamationTriangleIcon,
  EyeSlashIcon,
  InboxArrowDownIcon,
  RectangleStackIcon,
  SparklesIcon,
  UsersIcon,
} from '@heroicons/react/24/outline';
import {
  CalendarDaysIcon as FilledCalendarDaysIcon,
  ClockIcon as FilledClockIcon,
  CogIcon as FilledCogIcon,
  ExclamationTriangleIcon as FilledExclamationTriangleIcon,
  EyeSlashIcon as FilledEyeSlashIcon,
  InboxArrowDownIcon as FilledInboxArrowDownIcon,
  RectangleStackIcon as FilledRectangleStackIcon,
  SparklesIcon as FilledSparklesIcon,
  UsersIcon as FilledUsersIcon,
  XMarkIcon,
} from '@heroicons/react/24/solid';
import { cloneElement, useEffect, useRef, useState, type JSX } from 'react';
import { useIntl } from 'react-intl';
import { Link, useLocation } from 'react-router';

interface MobileMenuProps {
  pendingRequestsCount: number;
  openIssuesCount: number;
  activeInterventionsCount: number;
  revalidateIssueCount: () => void;
  revalidateRequestsCount: () => void;
}

interface MenuLink {
  href: string;
  svgIcon: JSX.Element;
  svgIconSelected: JSX.Element;
  content: React.ReactNode;
  activeRegExp: RegExp;
  as?: string;
  requiredPermission?: Permission | Permission[];
  permissionType?: 'and' | 'or';
  dataTestId?: string;
}

const MobileMenu = ({
  pendingRequestsCount,
  openIssuesCount,
  activeInterventionsCount,
  revalidateIssueCount,
  revalidateRequestsCount,
}: MobileMenuProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const intl = useIntl();
  const [isOpen, setIsOpen] = useState(false);
  const { hasPermission } = useUser();
  const location = useLocation();
  useClickOutside(ref, () => {
    setTimeout(() => {
      if (isOpen) {
        setIsOpen(false);
      }
    }, 150);
  });

  const toggle = () => setIsOpen(!isOpen);

  const menuLinks: MenuLink[] = [
    {
      href: '/',
      content: intl.formatMessage(menuMessages.dashboard),
      svgIcon: <SparklesIcon className="h-6 w-6" />,
      svgIconSelected: <FilledSparklesIcon className="h-6 w-6" />,
      activeRegExp: /^\/(?:discover(?:\/.*)?)?$/,
    },
    {
      href: '/library',
      content: intl.formatMessage(menuMessages.library),
      svgIcon: <RectangleStackIcon className="h-6 w-6" />,
      svgIconSelected: <FilledRectangleStackIcon className="h-6 w-6" />,
      activeRegExp: /^\/library/,
    },
    {
      href: '/requests',
      content: intl.formatMessage(menuMessages.requests),
      svgIcon: <ClockIcon className="h-6 w-6" />,
      svgIconSelected: <FilledClockIcon className="h-6 w-6" />,
      activeRegExp: /^\/requests/,
    },
    {
      href: '/calendar',
      content: intl.formatMessage(menuMessages.calendar),
      svgIcon: <CalendarDaysIcon className="h-6 w-6" />,
      svgIconSelected: <FilledCalendarDaysIcon className="h-6 w-6" />,
      activeRegExp: /^\/calendar/,
    },
    {
      href: '/interventions',
      content: intl.formatMessage(menuMessages.interventions),
      svgIcon: <InboxArrowDownIcon className="h-6 w-6" />,
      svgIconSelected: <FilledInboxArrowDownIcon className="h-6 w-6" />,
      activeRegExp: /^\/interventions/,
      requiredPermission: Permission.MANAGE_REQUESTS,
    },
    {
      href: '/blocklist',
      content: intl.formatMessage(menuMessages.blocklist),
      svgIcon: <EyeSlashIcon className="h-6 w-6" />,
      svgIconSelected: <FilledEyeSlashIcon className="h-6 w-6" />,
      activeRegExp: /^\/blocklist/,
      requiredPermission: [
        Permission.MANAGE_BLOCKLIST,
        Permission.VIEW_BLOCKLIST,
      ],
      permissionType: 'or',
    },
    {
      href: '/issues',
      content: intl.formatMessage(menuMessages.issues),
      svgIcon: <ExclamationTriangleIcon className="h-6 w-6" />,
      svgIconSelected: <FilledExclamationTriangleIcon className="h-6 w-6" />,
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
      content: intl.formatMessage(menuMessages.users),
      svgIcon: <UsersIcon className="mr-3 h-6 w-6" />,
      svgIconSelected: <FilledUsersIcon className="mr-3 h-6 w-6" />,
      activeRegExp: /^\/users/,
      requiredPermission: Permission.MANAGE_USERS,
      dataTestId: 'sidebar-menu-users',
    },
    {
      href: '/settings',
      content: intl.formatMessage(menuMessages.settings),
      svgIcon: <CogIcon className="mr-3 h-6 w-6" />,
      svgIconSelected: <FilledCogIcon className="mr-3 h-6 w-6" />,
      activeRegExp: /^\/settings/,
      requiredPermission: Permission.ADMIN,
      dataTestId: 'sidebar-menu-settings',
    },
  ];

  const filteredLinks = menuLinks.filter(
    (link) =>
      !link.requiredPermission ||
      hasPermission(link.requiredPermission, {
        type: link.permissionType ?? 'and',
      })
  );

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
    <div className="fixed bottom-0 left-0 right-0 z-50">
      <Transition
        show={isOpen}
        as="div"
        ref={ref}
        enter="transition duration-500"
        enterFrom="opacity-0 translate-y-0"
        enterTo="opacity-100 -translate-y-full"
        leave="transition duration-500"
        leaveFrom="opacity-100 -translate-y-full"
        leaveTo="opacity-0 translate-y-0"
        className="absolute left-0 right-0 top-0 flex w-full -translate-y-full flex-col space-y-6 border-t border-gray-600 bg-gray-900/90 px-6 py-6 font-semibold text-gray-100 backdrop-blur"
      >
        {filteredLinks.map((link) => {
          const isActive = location.pathname.match(link.activeRegExp);
          return (
            <Link
              key={`mobile-menu-link-${link.href}`}
              to={link.href}
              className={`flex items-center ${
                isActive ? 'text-indigo-500' : ''
              }`}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setIsOpen(false);
                }
              }}
              onClick={() => setIsOpen(false)}
              role="button"
              tabIndex={0}
            >
              {cloneElement(isActive ? link.svgIconSelected : link.svgIcon, {
                className: 'h-5 w-5',
              })}
              <span className="ml-2">{link.content}</span>
              {link.href === '/requests' &&
                pendingRequestsCount > 0 &&
                hasPermission(Permission.MANAGE_REQUESTS) && (
                  <div className="ml-auto flex">
                    <Badge className="rounded-md border-indigo-500 bg-gradient-to-br from-indigo-600 to-purple-600">
                      {pendingRequestsCount}
                    </Badge>
                  </div>
                )}
              {link.href === '/issues' &&
                openIssuesCount > 0 &&
                hasPermission(Permission.MANAGE_ISSUES) && (
                  <div className="ml-auto flex">
                    <Badge className="rounded-md border-indigo-500 bg-gradient-to-br from-indigo-600 to-purple-600">
                      {openIssuesCount}
                    </Badge>
                  </div>
                )}
              {link.href === '/interventions' &&
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
        <div className="border-t border-gray-700 pt-4">
          <QuitAppControl />
        </div>
      </Transition>
      <div className="padding-bottom-safe border-t border-gray-600 bg-gray-800/90 backdrop-blur">
        <div className="flex h-full items-center justify-between px-6 py-4 text-gray-100">
          {filteredLinks
            .slice(0, filteredLinks.length === 5 ? 5 : 4)
            .map((link) => {
              const isActive =
                location.pathname.match(link.activeRegExp) && !isOpen;
              return (
                <Link
                  key={`mobile-menu-link-${link.href}`}
                  to={link.href}
                  className={`relative flex flex-col items-center space-y-1 ${
                    isActive ? 'text-indigo-500' : ''
                  }`}
                >
                  {cloneElement(
                    isActive ? link.svgIconSelected : link.svgIcon,
                    {
                      className: 'h-6 w-6',
                    }
                  )}
                  {link.href === '/requests' &&
                    pendingRequestsCount > 0 &&
                    hasPermission(Permission.MANAGE_REQUESTS) && (
                      <div className="absolute bottom-3 left-3">
                        <Badge
                          className={`bg-gradient-to-br ${
                            location.pathname.match(link.activeRegExp)
                              ? 'border-indigo-600 from-indigo-700 to-purple-700'
                              : 'border-indigo-500 from-indigo-600 to-purple-600'
                          } flex ${
                            pendingRequestsCount > 99 ? 'w-6' : 'w-4'
                          } h-4 items-center justify-center !px-[5px] !py-[7px] text-[8px]`}
                        >
                          {pendingRequestsCount > 99
                            ? '99+'
                            : pendingRequestsCount}
                        </Badge>
                      </div>
                    )}
                  {link.href === '/interventions' &&
                    activeInterventionsCount > 0 && (
                      <div className="absolute bottom-3 left-3">
                        <Badge className="flex h-4 w-4 items-center justify-center rounded-md border-yellow-500 bg-yellow-600 !px-[5px] !py-[7px] text-[8px]">
                          {activeInterventionsCount > 99
                            ? '99+'
                            : activeInterventionsCount}
                        </Badge>
                      </div>
                    )}
                </Link>
              );
            })}
          {filteredLinks.length > 4 && filteredLinks.length !== 5 && (
            <button
              className={`relative flex flex-col items-center space-y-1 ${
                isOpen ? 'text-indigo-500' : ''
              }`}
              onClick={() => toggle()}
            >
              {isOpen ? (
                <XMarkIcon className="h-6 w-6" />
              ) : (
                <EllipsisHorizontalIcon className="h-6 w-6" />
              )}
              {activeInterventionsCount > 0 && !isOpen && (
                <div className="absolute bottom-3 left-3">
                  <Badge className="flex h-4 w-4 items-center justify-center rounded-md border-yellow-500 bg-yellow-600 !px-[5px] !py-[7px] text-[8px]">
                    {activeInterventionsCount > 99
                      ? '99+'
                      : activeInterventionsCount}
                  </Badge>
                </div>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default MobileMenu;
