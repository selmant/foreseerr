import { useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router';

export type RouteQuery = Record<string, string | string[] | undefined>;

const useRouteQuery = (): RouteQuery => {
  const params = useParams();
  const [searchParams] = useSearchParams();

  return useMemo(() => {
    const query: RouteQuery = { ...params };

    searchParams.forEach((value, key) => {
      query[key] = value;
    });

    return query;
  }, [params, searchParams]);
};

export default useRouteQuery;
