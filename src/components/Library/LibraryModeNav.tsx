import defineMessages from '@app/utils/defineMessages';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Library.LibraryModeNav', {
  overview: 'Overview',
  browse: 'Browse',
});

const LibraryModeNav = () => {
  const intl = useIntl();
  const router = useRouter();
  const browseActive = router.pathname.startsWith('/library/browse');

  return (
    <nav
      aria-label={intl.formatMessage(messages.browse)}
      className="mb-6 flex gap-2"
    >
      <Link
        href="/library"
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
        href="/library/browse"
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
