import type {
  TmdbCompanySearchResponse,
  TmdbKeywordSearchResponse,
} from '@server/api/themoviedb/interfaces';
import axios from 'axios';

export type SelectorOption = { label: string; value: number };

/**
 * Axios encodes query parameters. Passing the user's text directly avoids
 * turning characters such as `%` and `+` into a second layer of encoding.
 */
export async function loadCompanyOptions(
  inputValue: string
): Promise<SelectorOption[]> {
  if (inputValue === '') {
    return [];
  }

  const response = await axios.get<TmdbCompanySearchResponse>(
    '/api/v1/search/company',
    { params: { query: inputValue } }
  );

  return response.data.results.map((result) => ({
    label: result.name,
    value: result.id,
  }));
}

export async function loadKeywordOptions(
  inputValue: string
): Promise<SelectorOption[]> {
  const response = await axios.get<TmdbKeywordSearchResponse>(
    '/api/v1/search/keyword',
    { params: { query: inputValue } }
  );

  return response.data.results.map((result) => ({
    label: result.name,
    value: result.id,
  }));
}
