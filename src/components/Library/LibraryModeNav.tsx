import SegmentedControl from '@app/components/Common/SegmentedControl';
import defineMessages from '@app/utils/defineMessages';
import { HomeIcon, Squares2X2Icon } from '@heroicons/react/24/outline';
import { useIntl } from 'react-intl';
import { useLocation } from 'react-router';

const messages = defineMessages('components.Library.LibraryModeNav', {
  views: 'Library views',
  overview: 'Overview',
  browse: 'Browse',
});

type LibraryMode = 'overview' | 'browse';

const LibraryModeNav = () => {
  const intl = useIntl();
  const location = useLocation();

  return (
    <SegmentedControl<LibraryMode>
      ariaLabel={intl.formatMessage(messages.views)}
      className="mb-2 w-full sm:inline-grid sm:w-auto sm:min-w-[16rem]"
      value={
        location.pathname.startsWith('/library/browse') ? 'browse' : 'overview'
      }
      options={[
        {
          value: 'overview',
          href: '/library',
          label: intl.formatMessage(messages.overview),
          icon: HomeIcon,
        },
        {
          value: 'browse',
          href: '/library/browse',
          label: intl.formatMessage(messages.browse),
          icon: Squares2X2Icon,
        },
      ]}
    />
  );
};

export default LibraryModeNav;
