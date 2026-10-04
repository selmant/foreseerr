import { useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import type { Permission } from '@server/lib/permissions';
import { hasPermission } from '@server/lib/permissions';
import { useId } from 'react';
import { useIntl } from 'react-intl';
import { Link, useLocation, useNavigate } from 'react-router';

const messages = defineMessages('components.Common.SettingsTabs', {
  sections: 'Settings sections',
  section: 'Settings section',
  chooseSection: 'Choose a section',
});

export interface SettingsRoute {
  text: string;
  content?: React.ReactNode;
  route: string;
  regex: RegExp;
  requiredPermission?: Permission | Permission[];
  permissionType?: { type: 'and' | 'or' };
  hidden?: boolean;
}

const SettingsTabs = ({
  tabType = 'default',
  settingsRoutes,
}: {
  tabType?: 'default' | 'button';
  settingsRoutes: SettingsRoute[];
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user: currentUser } = useUser();
  const intl = useIntl();
  const selectId = useId();
  const visibleRoutes = settingsRoutes.filter(
    (route) =>
      !route.hidden &&
      (!route.requiredPermission ||
        hasPermission(
          route.requiredPermission,
          currentUser?.permissions ?? 0,
          route.permissionType
        ))
  );
  const selectedRoute =
    visibleRoutes.find((route) => location.pathname.match(route.regex))
      ?.route ?? '';

  return (
    <>
      <div className="sm:hidden">
        <label
          htmlFor={selectId}
          className="mb-2 block text-sm font-medium text-gray-400"
        >
          {intl.formatMessage(messages.section)}
        </label>
        <select
          id={selectId}
          className="min-h-[44px] w-full"
          value={selectedRoute}
          onChange={(event) => navigate(event.target.value)}
        >
          <option value="" disabled>
            {intl.formatMessage(messages.chooseSection)}
          </option>
          {visibleRoutes.map((route) => (
            <option key={route.route} value={route.route}>
              {route.text}
            </option>
          ))}
        </select>
      </div>
      <nav
        aria-label={intl.formatMessage(messages.sections)}
        data-testid="settings-nav-desktop"
        className={`hidden flex-wrap gap-2 sm:flex ${tabType === 'default' ? 'rounded-xl border border-gray-700 bg-gray-800/40 p-2' : ''}`}
      >
        {visibleRoutes.map((route) => {
          const active = route.route === selectedRoute;
          return (
            <Link
              key={route.route}
              to={route.route}
              aria-current={active ? 'page' : undefined}
              className={`inline-flex min-h-[44px] items-center rounded-lg px-3 py-2 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${active ? 'bg-indigo-500/15 text-indigo-300 ring-1 ring-indigo-500/30' : 'text-gray-400 hover:bg-gray-700/60 hover:text-white'}`}
            >
              {route.content ?? route.text}
            </Link>
          );
        })}
      </nav>
    </>
  );
};

export default SettingsTabs;
