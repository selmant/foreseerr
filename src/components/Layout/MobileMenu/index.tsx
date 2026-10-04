import Badge from '@app/components/Common/Badge';
import QuitAppControl from '@app/components/Layout/QuitAppControl';
import {
  menuMessages,
  useAppNavigation,
  type NavigationCounts,
} from '@app/components/Layout/navigation';
import { useNativeRuntime } from '@app/context/NativeRuntimeContext';
import useClickOutside from '@app/hooks/useClickOutside';
import { Transition } from '@headlessui/react';
import { EllipsisHorizontalIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { Link, useLocation } from 'react-router';

const MobileMenu = (counts: NavigationCounts) => {
  const ref = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const focusClose = useCallback(
    (button: HTMLButtonElement | null) => button?.focus(),
    []
  );
  const intl = useIntl();
  const { canQuit } = useNativeRuntime();
  const [isOpen, setIsOpen] = useState(false);
  const location = useLocation();
  const links = useAppNavigation(counts);
  const bottomBarLinks = links.filter((link) => link.group === 'explore');
  const moreLinks = links.filter((link) => link.group !== 'explore');
  const moreActive = moreLinks.some((link) =>
    location.pathname.match(link.activeRegExp)
  );
  const moreCount = moreLinks.reduce((total, link) => total + link.count, 0);
  useClickOutside(ref, () => setIsOpen(false));

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        moreRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isOpen]);

  return (
    <div ref={ref} className="fixed bottom-0 left-0 right-0 z-50">
      <Transition
        show={isOpen}
        as="div"
        enter="transition duration-200"
        enterFrom="opacity-0 translate-y-4"
        enterTo="opacity-100 translate-y-0"
        leave="transition duration-150"
        leaveFrom="opacity-100 translate-y-0"
        leaveTo="opacity-0 translate-y-4"
        className="absolute bottom-full left-0 right-0 max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-t-2xl border border-gray-700 bg-gray-900/95 p-4 shadow-2xl backdrop-blur"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="px-2 text-lg font-semibold text-white">
            {intl.formatMessage(menuMessages.more)}
          </h2>
          <button
            ref={focusClose}
            type="button"
            aria-label={intl.formatMessage(menuMessages.close)}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-indigo-400"
            onClick={() => {
              setIsOpen(false);
              moreRef.current?.focus();
            }}
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>
        <nav
          id="mobile-more-navigation"
          aria-label={intl.formatMessage(menuMessages.more)}
          className="space-y-4"
        >
          {(['manage', 'account'] as const).map((group) => {
            const groupLinks = moreLinks.filter((link) => link.group === group);
            if (!groupLinks.length) return null;
            return (
              <div key={group}>
                <p className="mb-1 px-3 text-xs font-semibold uppercase tracking-wider text-gray-400">
                  {intl.formatMessage(menuMessages[group])}
                </p>
                {groupLinks.map((link) => {
                  const active = !!location.pathname.match(link.activeRegExp);
                  return (
                    <Link
                      key={link.href}
                      to={link.href}
                      aria-current={active ? 'page' : undefined}
                      onClick={() => setIsOpen(false)}
                      data-testid={
                        link.dataTestId
                          ? `${link.dataTestId}-mobile`
                          : undefined
                      }
                      className={`flex min-h-[48px] items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition focus-visible:ring-2 focus-visible:ring-indigo-400 ${active ? 'bg-indigo-500/15 text-indigo-300' : 'text-gray-300 hover:bg-gray-800'}`}
                    >
                      <link.Icon
                        aria-hidden="true"
                        className="h-5 w-5 shrink-0"
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
            );
          })}
        </nav>
        {canQuit && (
          <div className="mt-4 border-t border-gray-700 px-3 py-4">
            <QuitAppControl variant="menu" />
          </div>
        )}
      </Transition>
      <nav
        aria-label={intl.formatMessage(menuMessages.navigation)}
        className="padding-bottom-safe border-t border-gray-700 bg-gray-900/95 backdrop-blur"
      >
        <div className="grid grid-cols-5 gap-1 px-2 py-2">
          {bottomBarLinks.map((link) => {
            const active = !!location.pathname.match(link.activeRegExp);
            return (
              <Link
                key={link.href}
                to={link.href}
                aria-current={active ? 'page' : undefined}
                onClick={() => setIsOpen(false)}
                className={`relative flex min-h-[48px] flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 focus-visible:ring-2 focus-visible:ring-indigo-400 ${active ? 'bg-indigo-500/10 text-indigo-300' : 'text-gray-400 hover:text-white'}`}
              >
                <link.Icon aria-hidden="true" className="h-5 w-5" />
                <span className="max-w-full truncate text-[10px] font-medium">
                  {intl.formatMessage(menuMessages[link.messagesKey])}
                </span>
                {link.count > 0 && (
                  <span className="absolute right-1 top-0 rounded-full bg-indigo-600 px-1.5 text-[10px] text-white">
                    {link.count > 99 ? '99+' : link.count}
                  </span>
                )}
              </Link>
            );
          })}
          <button
            ref={moreRef}
            type="button"
            aria-expanded={isOpen}
            aria-controls={isOpen ? 'mobile-more-navigation' : undefined}
            onClick={() => setIsOpen(!isOpen)}
            className={`relative flex min-h-[48px] flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 focus-visible:ring-2 focus-visible:ring-indigo-400 ${isOpen || moreActive ? 'bg-indigo-500/10 text-indigo-300' : 'text-gray-400 hover:text-white'}`}
          >
            <EllipsisHorizontalIcon aria-hidden="true" className="h-5 w-5" />
            <span className="text-[10px] font-medium">
              {intl.formatMessage(menuMessages.more)}
            </span>
            {moreCount > 0 && (
              <span className="absolute right-1 top-0 rounded-full bg-indigo-600 px-1.5 text-[10px] text-white">
                {moreCount > 99 ? '99+' : moreCount}
              </span>
            )}
          </button>
        </div>
      </nav>
    </div>
  );
};

export default MobileMenu;
