import {
  buildPath,
  setSearchParamsFromQuery,
  type QueryRecord,
} from '@app/utils/routing';
import { useCallback } from 'react';
import {
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router';

type RouterAction = 'push' | 'replace';

export const useQueryParams = (): ((
  query: QueryRecord,
  routerAction?: RouterAction
) => void) => {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const [searchParams] = useSearchParams();
  const paramKeys = Object.keys(params);

  return useCallback(
    (query: QueryRecord, routerAction: RouterAction = 'push') => {
      const nextSearchParams = setSearchParamsFromQuery(
        searchParams,
        query,
        paramKeys
      );
      const nextPath = buildPath(
        location.pathname,
        Object.fromEntries(nextSearchParams.entries())
      );
      const currentPath = `${location.pathname}${location.search}`;

      if (nextPath !== currentPath) {
        navigate(nextPath, { replace: routerAction === 'replace' });
      }
    },
    [location.pathname, location.search, navigate, paramKeys, searchParams]
  );
};

export const useUpdateQueryParams = (
  filter: QueryRecord
): ((key: string, value?: string) => void) => {
  const updateQueryParams = useQueryParams();

  return useCallback(
    (key: string, value?: string) => {
      updateQueryParams(
        {
          ...filter,
          [key]: value,
        },
        'replace'
      );
    },
    [filter, updateQueryParams]
  );
};

export const useBatchUpdateQueryParams = (
  filter: QueryRecord
): ((items: Record<string, string | undefined>) => void) => {
  const updateQueryParams = useQueryParams();

  return useCallback(
    (items: Record<string, string | undefined>) => {
      updateQueryParams(
        {
          ...filter,
          ...items,
        },
        'replace'
      );
    },
    [filter, updateQueryParams]
  );
};
