import useRouteQuery from '@app/hooks/useRouteQuery';
import { buildPath } from '@app/utils/routing';
import type { Nullable } from '@app/utils/typeHelpers';
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import useDebouncedState from './useDebouncedState';

interface SearchObject {
  searchValue: string;
  searchOpen: boolean;
  setIsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSearchValue: React.Dispatch<React.SetStateAction<string>>;
  clear: () => void;
}

const queryFromRoute = (query: string | string[] | undefined): string => {
  if (Array.isArray(query)) {
    return query[0] ?? '';
  }

  return query ?? '';
};

const useSearchInput = (): SearchObject => {
  const navigate = useNavigate();
  const location = useLocation();
  const routeQuery = useRouteQuery();
  const urlQuery = queryFromRoute(routeQuery.query);
  const [searchOpen, setIsOpen] = useState(false);
  const [lastRoute, setLastRoute] = useState<Nullable<string>>(null);
  const [searchValue, debouncedValue, setSearchValue] =
    useDebouncedState(urlQuery);

  useEffect(() => {
    if (debouncedValue === '' || !searchOpen) {
      return;
    }

    if (
      location.pathname.startsWith('/search') &&
      urlQuery === debouncedValue
    ) {
      return;
    }

    if (location.pathname.startsWith('/search')) {
      navigate(buildPath('/search', { query: debouncedValue }), {
        replace: true,
      });
    } else {
      setLastRoute(`${location.pathname}${location.search}`);
      navigate(buildPath('/search', { query: debouncedValue }));
      window.scrollTo(0, 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedValue]);

  useEffect(() => {
    if (
      searchValue === '' &&
      location.pathname.startsWith('/search') &&
      !searchOpen
    ) {
      if (lastRoute) {
        navigate(lastRoute);
        window.scrollTo(0, 0);
      } else {
        navigate('/', { replace: true });
        window.scrollTo(0, 0);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchOpen]);

  useEffect(() => {
    if (urlQuery !== searchValue && urlQuery !== debouncedValue) {
      setSearchValue(urlQuery);
    }

    if (!location.pathname.startsWith('/search') && !urlQuery) {
      setIsOpen(false);
    }

    if (location.pathname.startsWith('/search')) {
      setIsOpen(true);
    }
    // Sync from the URL on location change only. Tying this to debouncedValue
    // writes the previous query back before the new URL commits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, location.search]);

  const clear = () => {
    setIsOpen(false);
    setSearchValue('');
  };

  return {
    searchValue,
    searchOpen,
    setIsOpen,
    setSearchValue,
    clear,
  };
};

export default useSearchInput;
