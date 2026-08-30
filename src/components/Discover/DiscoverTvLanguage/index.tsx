import Header from '@app/components/Common/Header';
import ListView from '@app/components/Common/ListView';
import PageTitle from '@app/components/Common/PageTitle';
import useDiscover from '@app/hooks/useDiscover';
import useRouteQuery from '@app/hooks/useRouteQuery';
import globalMessages from '@app/i18n/globalMessages';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import type { TvResult } from '@server/models/Search';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.DiscoverTvLanguage', {
  languageSeries: '{language} Series',
});

const DiscoverTvLanguage = () => {
  const query = useRouteQuery();
  const intl = useIntl();

  const {
    isLoadingInitialData,
    isEmpty,
    isLoadingMore,
    isReachingEnd,
    titles,
    fetchMore,
    error,
  } = useDiscover<
    TvResult,
    {
      originalLanguage: {
        iso_639_1: string;
        english_name: string;
        name: string;
      };
    }
  >(`/api/v1/discover/tv/language/${query.language}`);

  if (error) {
    return <ErrorPage statusCode={500} />;
  }

  const title = isLoadingInitialData
    ? intl.formatMessage(globalMessages.loading)
    : intl.formatMessage(messages.languageSeries, {
        language: intl.formatDisplayName(query.language as string, {
          type: 'language',
          fallback: 'none',
        }),
      });

  return (
    <>
      <PageTitle title={title} />
      <div className="mb-5 mt-1">
        <Header>{title}</Header>
      </div>
      <ListView
        items={titles}
        isEmpty={isEmpty}
        isLoading={
          isLoadingInitialData || (isLoadingMore && (titles?.length ?? 0) > 0)
        }
        isReachingEnd={isReachingEnd}
        onScrollBottom={fetchMore}
      />
    </>
  );
};

export default DiscoverTvLanguage;
