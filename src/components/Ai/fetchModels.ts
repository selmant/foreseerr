import type { AiModel } from '@shared/interfaces/api/aiInterfaces';
import axios from 'axios';

/**
 * SWR fetcher for a connection's model list. Its key is `[url, version]`:
 * the version (the connection's `updatedAt`) makes SWR fetch again after the
 * connection changes, but isn't sent, since the API rejects unknown query
 * parameters.
 */
export const fetchModels = ([url]: readonly [string, string | null]) =>
  axios.get<AiModel[]>(url).then((res) => res.data);
