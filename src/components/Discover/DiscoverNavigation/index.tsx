import SegmentedControl from '@app/components/Common/SegmentedControl';
import {
  getDiscoverSource,
  isSourceViewActive,
  sourceMessages,
  sourceViewHref,
} from '@app/components/Discover/sourceCatalog';
import defineMessages from '@app/utils/defineMessages';
import {
  FilmIcon,
  SparklesIcon,
  Squares2X2Icon,
  TvIcon,
} from '@heroicons/react/24/outline';
import { useIntl } from 'react-intl';
import { Link, useLocation } from 'react-router';

const messages = defineMessages('components.Layout.Sidebar', {
  dashboard: 'Discover',
  browsemovies: 'Movies',
  browsetv: 'Series',
});

type DiscoverSection = 'discover' | 'movies' | 'tv' | 'sources';

const DiscoverNavigation = () => {
  const intl = useIntl();
  const location = useLocation();
  const source = getDiscoverSource(location.pathname);
  const current: DiscoverSection = location.pathname.startsWith(
    '/discover/movies'
  )
    ? 'movies'
    : location.pathname.startsWith('/discover/tv')
      ? 'tv'
      : source || location.pathname === '/discover/sources'
        ? 'sources'
        : 'discover';

  return (
    <div className="mb-4">
      <SegmentedControl<DiscoverSection>
        ariaLabel={intl.formatMessage(messages.dashboard)}
        className="w-full sm:inline-grid sm:w-auto sm:min-w-[30rem] [&_a]:px-1.5 [&_a]:text-xs sm:[&_a]:px-3 sm:[&_a]:text-sm [&_svg]:hidden sm:[&_svg]:block"
        value={current}
        options={[
          {
            value: 'discover',
            href: '/',
            label: intl.formatMessage(messages.dashboard),
            icon: SparklesIcon,
          },
          {
            value: 'movies',
            href: '/discover/movies',
            label: intl.formatMessage(messages.browsemovies),
            icon: FilmIcon,
          },
          {
            value: 'tv',
            href: '/discover/tv',
            label: intl.formatMessage(messages.browsetv),
            icon: TvIcon,
          },
          {
            value: 'sources',
            href: '/discover/sources',
            label: intl.formatMessage(sourceMessages.title),
            icon: Squares2X2Icon,
          },
        ]}
      />
      {source && source.views.length > 0 && (
        <nav
          aria-label={intl.formatMessage(sourceMessages.navigation, {
            source: source.name,
          })}
          className="mt-3 flex flex-wrap items-center gap-1.5"
        >
          <span className="mr-2 text-sm font-semibold text-gray-400">
            {source.name}
          </span>
          {source.views.map((view) => {
            const active = isSourceViewActive(
              view.href,
              location.pathname,
              location.search
            );
            return (
              <Link
                key={view.href}
                to={sourceViewHref(view.href, location.search)}
                aria-current={active ? 'page' : undefined}
                className={`inline-flex min-h-[44px] items-center rounded-lg px-3 py-2 text-sm transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 ${active ? 'bg-indigo-500/15 text-indigo-300 ring-1 ring-indigo-500/30' : 'text-gray-400 hover:bg-gray-800 hover:text-white'}`}
              >
                {intl.formatMessage(sourceMessages[view.label])}
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );
};

export default DiscoverNavigation;
