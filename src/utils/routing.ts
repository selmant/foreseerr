import type { NavigateFunction } from 'react-router';

export type QueryRecord = Record<string, string | string[] | undefined | null>;

export const buildPath = (pathname: string, query?: QueryRecord): string => {
  const params = new URLSearchParams();

  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value == null || value === '') {
        return;
      }

      if (Array.isArray(value)) {
        value.forEach((entry) => {
          if (entry != null && entry !== '') {
            params.append(key, entry);
          }
        });
        return;
      }

      params.set(key, value);
    });
  }

  const search = params.toString();
  return search ? `${pathname}?${search}` : pathname;
};

export const navigateWithQuery = (
  navigate: NavigateFunction,
  pathname: string,
  query: QueryRecord,
  options?: {
    replace?: boolean;
    excludeKeys?: string[];
  }
): void => {
  const nextQuery = { ...query };

  options?.excludeKeys?.forEach((key) => {
    delete nextQuery[key];
  });

  navigate(buildPath(pathname, nextQuery), {
    replace: options?.replace,
  });
};

export const setSearchParamsFromQuery = (
  current: URLSearchParams,
  query: QueryRecord,
  excludeKeys: string[] = []
): URLSearchParams => {
  const next = new URLSearchParams(current);

  Object.entries(query).forEach(([key, value]) => {
    if (excludeKeys.includes(key)) {
      return;
    }

    next.delete(key);

    if (value == null || value === '') {
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((entry) => {
        if (entry != null && entry !== '') {
          next.append(key, entry);
        }
      });
      return;
    }

    next.set(key, value);
  });

  return next;
};
