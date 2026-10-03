import SegmentedControl from '@app/components/Common/SegmentedControl';
import defineMessages from '@app/utils/defineMessages';
import { FilmIcon, SparklesIcon, TvIcon } from '@heroicons/react/24/outline';
import { useIntl } from 'react-intl';
import { useLocation } from 'react-router';

const messages = defineMessages('components.Layout.Sidebar', {
  dashboard: 'Discover',
  browsemovies: 'Movies',
  browsetv: 'Series',
});

type DiscoverSection = 'discover' | 'movies' | 'tv';

const DiscoverNavigation = () => {
  const intl = useIntl();
  const location = useLocation();
  // Provider pages (Trakt, AniList, MDBList, ...) open from the Discover home,
  // so they keep the Discover tab selected like the sidebar does.
  const current: DiscoverSection = location.pathname.startsWith(
    '/discover/movies'
  )
    ? 'movies'
    : location.pathname.startsWith('/discover/tv')
      ? 'tv'
      : 'discover';

  return (
    <SegmentedControl<DiscoverSection>
      ariaLabel={intl.formatMessage(messages.dashboard)}
      className="mb-2 w-full sm:inline-grid sm:w-auto sm:min-w-[24rem]"
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
      ]}
    />
  );
};

export default DiscoverNavigation;
