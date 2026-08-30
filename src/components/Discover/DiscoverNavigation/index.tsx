import defineMessages from '@app/utils/defineMessages';
import { FilmIcon, SparklesIcon, TvIcon } from '@heroicons/react/24/outline';
import { useIntl } from 'react-intl';
import { Link, useLocation } from 'react-router';

const messages = defineMessages('components.Layout.Sidebar', {
  dashboard: 'Discover',
  browsemovies: 'Movies',
  browsetv: 'Series',
});

const DiscoverNavigation = () => {
  const intl = useIntl();
  const location = useLocation();
  const routes = [
    {
      href: '/',
      label: intl.formatMessage(messages.dashboard),
      icon: SparklesIcon,
      isActive: location.pathname === '/' || location.pathname === '/discover',
    },
    {
      href: '/discover/movies',
      label: intl.formatMessage(messages.browsemovies),
      icon: FilmIcon,
      isActive: location.pathname.startsWith('/discover/movies'),
    },
    {
      href: '/discover/tv',
      label: intl.formatMessage(messages.browsetv),
      icon: TvIcon,
      isActive: location.pathname.startsWith('/discover/tv'),
    },
  ];

  return (
    <nav aria-label={intl.formatMessage(messages.dashboard)} className="mb-6">
      <div className="grid w-full grid-cols-3 gap-1 rounded-xl border border-gray-700 bg-gray-900/70 p-1 shadow-sm sm:inline-grid sm:w-auto sm:min-w-[24rem]">
        {routes.map(({ href, label, icon: Icon, isActive }) => (
          <Link
            key={href}
            to={href}
            aria-current={isActive ? 'page' : undefined}
            className={`flex min-h-[44px] items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
              isActive
                ? 'bg-gray-700 text-white shadow ring-1 ring-white/10'
                : 'text-gray-400 hover:bg-gray-800 hover:text-gray-100'
            }`}
          >
            <Icon
              aria-hidden="true"
              className={`h-5 w-5 ${isActive ? 'text-indigo-400' : ''}`}
            />
            <span>{label}</span>
          </Link>
        ))}
      </div>
    </nav>
  );
};

export default DiscoverNavigation;
