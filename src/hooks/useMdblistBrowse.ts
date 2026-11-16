import { encodeURIExtraParams } from '@app/hooks/useDiscover';
import useSettings from '@app/hooks/useSettings';
import { loadMdblistPages, type MdblistPage } from '@app/utils/mdblistBrowse';
import axios from 'axios';
import useSWR from 'swr';

export const mdblistBrowseEndpoint = (url: string) =>
  `/api/v1/discover/mdblist/list?url=${encodeURIExtraParams(url)}`;

export const mdblistBrowseCacheKey = (endpoint: string) =>
  `${endpoint}#complete`;

export const fetchMdblistBrowse = (endpoint: string): Promise<MdblistPage> =>
  loadMdblistPages(async (page) => {
    const { data } = await axios.get<MdblistPage>(endpoint, {
      params: { page },
    });
    return data;
  });

const useMdblistBrowse = (url: string) => {
  const settings = useSettings();
  const endpoint = mdblistBrowseEndpoint(url);
  return useSWR<MdblistPage>(
    url && settings.currentSettings.mdblistConfigured
      ? mdblistBrowseCacheKey(endpoint)
      : null,
    () => fetchMdblistBrowse(endpoint),
    { revalidateOnFocus: false, dedupingInterval: 60000 }
  );
};

export default useMdblistBrowse;
