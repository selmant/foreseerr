import AppImage from '@app/components/Common/AppImage';
import Badge from '@app/components/Common/Badge';
import QuitAppControl from '@app/components/Layout/QuitAppControl';
import VersionStatus from '@app/components/Layout/VersionStatus';
import {
  menuMessages,
  useAppNavigation,
  type NavigationCounts,
} from '@app/components/Layout/navigation';
import useClickOutside from '@app/hooks/useClickOutside';
import { Permission, useUser } from '@app/hooks/useUser';
import { Transition, TransitionChild } from '@headlessui/react';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { Fragment, useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';
import { Link, useLocation } from 'react-router';

type SidebarProps = NavigationCounts & {
  open?: boolean;
  setClosed: () => void;
};

const Sidebar = ({ open, setClosed, ...counts }: SidebarProps) => {
  const navRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const intl = useIntl();
  const { hasPermission } = useUser();
  const links = useAppNavigation(counts);
  useClickOutside(navRef, () => setClosed());
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setClosed();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, setClosed]);

  const content = (mobile: boolean) => (
    <>
      <Link
        to="/"
        onClick={mobile ? setClosed : undefined}
        className="relative mx-4 mb-4 mt-2 block h-20 shrink-0"
      >
        <AppImage src="/logo_full.svg" alt="Foreseerr" fill loading="eager" />
      </Link>
      <nav
        aria-label={intl.formatMessage(menuMessages.navigation)}
        className="flex-1 space-y-5 px-3 pb-6"
      >
        {(['explore', 'manage', 'account'] as const).map((group) => {
          const groupLinks = links.filter((link) => link.group === group);
          if (!groupLinks.length) return null;
          return (
            <div key={group}>
              <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
                {intl.formatMessage(menuMessages[group])}
              </p>
              <div className="space-y-1">
                {groupLinks.map((link) => {
                  const active = !!location.pathname.match(link.activeRegExp);
                  return (
                    <Link
                      key={link.href}
                      to={link.href}
                      onClick={mobile ? setClosed : undefined}
                      aria-current={active ? 'page' : undefined}
                      data-testid={
                        link.dataTestId
                          ? `${link.dataTestId}${mobile ? '-mobile' : ''}`
                          : undefined
                      }
                      className={`flex min-h-[44px] items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${active ? 'bg-indigo-500/15 text-indigo-200 ring-1 ring-indigo-500/30' : 'text-gray-300 hover:bg-gray-700/60 hover:text-white'}`}
                    >
                      <link.Icon
                        aria-hidden="true"
                        className={`h-5 w-5 shrink-0 ${active ? 'text-indigo-400' : 'text-gray-400'}`}
                      />
                      <span>
                        {intl.formatMessage(menuMessages[link.messagesKey])}
                      </span>
                      {link.count > 0 && (
                        <Badge className="ml-auto border-indigo-500/30 bg-indigo-500/20 text-indigo-200">
                          {link.count}
                        </Badge>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>
      <div className="mt-auto space-y-2 px-3 pb-4">
        <QuitAppControl />
        {hasPermission(Permission.ADMIN) && (
          <VersionStatus onClick={mobile ? setClosed : undefined} />
        )}
      </div>
    </>
  );

  return (
    <>
      <div className="lg:hidden">
        <Transition as={Fragment} show={open}>
          <div className="fixed inset-0 z-40 flex">
            <TransitionChild
              as="div"
              enter="transition-opacity duration-200"
              enterFrom="opacity-0"
              enterTo="opacity-100"
              leave="transition-opacity duration-200"
              leaveFrom="opacity-100"
              leaveTo="opacity-0"
            >
              <div className="fixed inset-0 bg-gray-900/90" />
            </TransitionChild>
            <TransitionChild
              as="div"
              enter="transition-transform duration-200"
              enterFrom="-translate-x-full"
              enterTo="translate-x-0"
              leave="transition-transform duration-200"
              leaveFrom="translate-x-0"
              leaveTo="-translate-x-full"
            >
              <div
                ref={navRef}
                className="sidebar relative flex h-full w-72 flex-col overflow-y-auto"
              >
                <button
                  type="button"
                  aria-label={intl.formatMessage(menuMessages.close)}
                  onClick={setClosed}
                  className="absolute right-2 top-2 z-10 flex h-10 w-10 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-700 hover:text-white focus-visible:ring-2 focus-visible:ring-indigo-400"
                >
                  <XMarkIcon className="h-5 w-5" />
                </button>
                {content(true)}
              </div>
            </TransitionChild>
          </div>
        </Transition>
      </div>
      <div className="sidebar fixed bottom-0 left-0 top-0 z-30 hidden w-64 flex-col overflow-y-auto lg:flex">
        {content(false)}
      </div>
    </>
  );
};

export default Sidebar;
