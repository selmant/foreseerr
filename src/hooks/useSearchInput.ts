/* eslint-disable react-hooks/exhaustive-deps */
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

const useSearchInput = (): SearchObject => {
  const navigate = useNavigate();
  const location = useLocation();
  const query = useRouteQuery();
  const [searchOpen, setIsOpen] = useState(false);
  const [lastRoute, setLastRoute] = useState<Nullable<string>>(null);
  const [searchValue, debouncedValue, setSearchValue] = useDebouncedState(
    (query.query as string) ?? ''
  );

  useEffect(() => {
    if (debouncedValue !== '' && searchOpen) {
      if (location.pathname.startsWith('/search')) {
        navigate(
          buildPath(location.pathname, {
            ...query,
            query: debouncedValue,
          }),
          { replace: true }
        );
      } else {
        setLastRoute(`${location.pathname}${location.search}`);
        navigate(buildPath('/search', { query: debouncedValue }));
        window.scrollTo(0, 0);
      }
    }
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
  }, [searchOpen]);

  useEffect(() => {
    if (query.query !== debouncedValue) {
      setSearchValue(
        query.query ? decodeURIComponent(query.query as string) : ''
      );

      if (!location.pathname.startsWith('/search') && !query.query) {
        setIsOpen(false);
      }
    }

    if (location.pathname.startsWith('/search')) {
      setIsOpen(true);
    }
  }, [
    location.pathname,
    location.search,
    query.query,
    debouncedValue,
    setSearchValue,
  ]);

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
