import DiscoverProviderSlider from '@app/components/Discover/DiscoverProviderSlider';
import {
  fetchMdblistBrowse,
  mdblistBrowseEndpoint,
  mdblistBrowseCacheKey,
} from '@app/hooks/useMdblistBrowse';
import { mdblistSort, viewMdblistItems } from '@app/utils/mdblistBrowse';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.MdblistListSlider', {
  empty: 'No items found for this MDBList list.',
});

interface MdblistListSliderProps {
  title: string;
  url: string;
  sliderKey: string;
  sort?: string;
  hideTitle?: boolean;
  onNewTitles?: (titleCount: number) => void;
}

const MdblistListSlider = ({
  title,
  url,
  sliderKey,
  sort,
  hideTitle = false,
  onNewTitles,
}: MdblistListSliderProps) => {
  const intl = useIntl();
  const settings = useSettings();
  const sortBy = mdblistSort(sort);
  const reorder = sortBy !== 'source';
  const endpoint = url ? mdblistBrowseEndpoint(url) : null;

  return (
    <DiscoverProviderSlider
      source="mdblist"
      configured={settings.currentSettings.mdblistConfigured}
      title={title}
      endpoint={endpoint}
      cacheKey={
        endpoint && reorder ? mdblistBrowseCacheKey(endpoint) : endpoint
      }
      linkUrl={`/discover/mdblist/list?url=${encodeURIComponent(url)}${reorder ? `&sortBy=${sortBy}` : ''}`}
      fetcher={reorder ? fetchMdblistBrowse : undefined}
      transformResults={
        reorder ? (items) => viewMdblistItems(items, { sortBy }) : undefined
      }
      itemLimit={reorder ? 20 : undefined}
      sliderKey={sliderKey}
      emptyMessage={intl.formatMessage(messages.empty)}
      hideTitle={hideTitle}
      onNewTitles={onNewTitles}
    />
  );
};

export default MdblistListSlider;
