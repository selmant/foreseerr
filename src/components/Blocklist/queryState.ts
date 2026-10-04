export type BlocklistSource = 'all' | 'manual' | 'blocklistedTags';

export interface BlocklistQueryState {
  filter: BlocklistSource;
  q: string;
  page: number;
  pageSize: number;
}

export const blocklistPageSizes = [5, 10, 25, 50, 100];

export const parseBlocklistQuery = (search: string): BlocklistQueryState => {
  const params = new URLSearchParams(search);
  const filter = params.get('filter');
  const page = Number(params.get('page'));
  const pageSize = Number(params.get('pageSize'));
  return {
    filter:
      filter === 'manual' || filter === 'blocklistedTags' ? filter : 'all',
    q: params.get('q')?.trim() ?? '',
    page: Number.isSafeInteger(page) && page > 0 ? page : 1,
    pageSize: blocklistPageSizes.includes(pageSize) ? pageSize : 10,
  };
};

export const blocklistPath = (state: BlocklistQueryState): string => {
  const params = new URLSearchParams();
  if (state.filter !== 'all') params.set('filter', state.filter);
  if (state.q.trim()) params.set('q', state.q.trim());
  if (state.page > 1) params.set('page', String(state.page));
  if (state.pageSize !== 10) params.set('pageSize', String(state.pageSize));
  return `/blocklist${params.size ? `?${params}` : ''}`;
};
