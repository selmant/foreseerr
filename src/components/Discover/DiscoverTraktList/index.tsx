import TraktDiscoverPage from '@app/components/Discover/TraktDiscoverPage';
import useRouteQuery from '@app/hooks/useRouteQuery';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.DiscoverTraktList', {
  title: 'Trakt List',
  missingUrl: 'A Trakt list URL is required.',
});

const DiscoverTraktList = () => {
  const intl = useIntl();
  const query = useRouteQuery();
  const url = typeof query.url === 'string' ? query.url : '';

  return (
    <TraktDiscoverPage
      title={intl.formatMessage(messages.title)}
      endpoint="/api/v1/discover/trakt/list"
      queryExcludes={['url', 'sort']}
      missingMessage={intl.formatMessage(messages.missingUrl)}
      urlReady={Boolean(url)}
      registerHideWatched
    />
  );
};

export default DiscoverTraktList;
