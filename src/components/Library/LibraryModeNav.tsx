import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';
import { Link, useLocation } from 'react-router';

const messages = defineMessages('components.Library.LibraryModeNav', {
  views: 'Library views',
  overview: 'Overview',
  browse: 'Browse',
});

const LibraryModeNav = () => {
  const intl = useIntl();
  const location = useLocation();
  const browseActive = location.pathname.startsWith('/library/browse');

  return (
    <nav
      aria-label={intl.formatMessage(messages.views)}
      className="flex shrink-0 gap-2"
    >
      <Link
        to="/library"
        className={`inline-flex min-h-11 items-center rounded-md px-4 py-2 text-sm font-medium ${
          !browseActive
            ? 'bg-indigo-600 text-white'
            : 'bg-library-charcoal text-gray-300 ring-1 ring-gray-700 hover:bg-gray-800'
        }`}
        aria-current={!browseActive ? 'page' : undefined}
      >
        {intl.formatMessage(messages.overview)}
      </Link>
      <Link
        to="/library/browse"
        className={`inline-flex min-h-11 items-center rounded-md px-4 py-2 text-sm font-medium ${
          browseActive
            ? 'bg-indigo-600 text-white'
            : 'bg-library-charcoal text-gray-300 ring-1 ring-gray-700 hover:bg-gray-800'
        }`}
        aria-current={browseActive ? 'page' : undefined}
      >
        {intl.formatMessage(messages.browse)}
      </Link>
    </nav>
  );
};

export default LibraryModeNav;
