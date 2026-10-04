import useRouteQuery from '@app/hooks/useRouteQuery';
import { buildPath } from '@app/utils/routing';
import type { Nullable } from '@app/utils/typeHelpers';
import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import useDebouncedState from './useDebouncedState';

interface SearchObject {
  searchValue: string;
  searchOpen: boolean;
  setIsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setSearchValue: React.Dispatch<React.SetStateAction<string>>;
  clear: () => void;
  submit: () => boolean;
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
  const urlQuery = location.pathname.startsWith('/search')
    ? queryFromRoute(routeQuery.query)
    : '';
  const [searchOpen, setIsOpen] = useState(false);
  const lastRoute = useRef<Nullable<string>>(null);
  const pendingQuery = useRef<Nullable<string>>(null);
  const [searchValue, debouncedValue, setSearchValue] =
    useDebouncedState(urlQuery);

  const navigateToSearch = (value: string): boolean => {
    const term = value.trim();
    if (!term) return false;
    if (location.pathname.startsWith('/search') && urlQuery === term)
      return true;
    if (pendingQuery.current === term) return true;
    pendingQuery.current = term;

    if (location.pathname.startsWith('/search')) {
      navigate(buildPath('/search', { query: term }), { replace: true });
    } else {
      lastRoute.current = `${location.pathname}${location.search}${location.hash}`;
      navigate(buildPath('/search', { query: term }));
      window.scrollTo(0, 0);
    }
    return true;
  };

  useEffect(() => {
    if (!searchOpen) return;
    navigateToSearch(debouncedValue);
    // Route changes synchronize the input below; this effect runs when typing settles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedValue]);

  useEffect(() => {
    pendingQuery.current = null;
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
    const wasNavigating = pendingQuery.current !== null;
    pendingQuery.current = null;
    setIsOpen(false);
    setSearchValue('');
    if (location.pathname.startsWith('/search') || wasNavigating) {
      navigate(
        lastRoute.current ??
          (wasNavigating
            ? `${location.pathname}${location.search}${location.hash}`
            : '/'),
        { replace: true }
      );
      window.scrollTo(0, 0);
    }
  };

  const submit = () => {
    const term = searchValue.trim();
    if (!term) return false;
    setSearchValue(term);
    setIsOpen(true);
    return navigateToSearch(term);
  };

  return {
    searchValue,
    searchOpen,
    setIsOpen,
    setSearchValue,
    clear,
    submit,
  };
};

export default useSearchInput;
