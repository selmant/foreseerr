import type { User } from '@app/hooks/useUser';
import { useUser } from '@app/hooks/useUser';
import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';

interface UserContextProps {
  initialUser?: User;
  children?: React.ReactNode;
}

/**
 * This UserContext serves the purpose of just preparing the useUser hooks
 * cache on server side render. It also will handle redirecting the user to
 * the login page if their session ever becomes invalid.
 */
export const UserContext = ({ initialUser, children }: UserContextProps) => {
  const { user, revalidate } = useUser({ initialData: initialUser });
  const location = useLocation();
  const routing = useRef(false);

  useEffect(() => {
    revalidate();
  }, [`${location.pathname}${location.search}`, revalidate]);

  useEffect(() => {
    if (
      !/^\/(setup|login|resetpassword)(\/|$)/.test(
        `${location.pathname}${location.search}`
      ) &&
      !user &&
      !routing.current
    ) {
      routing.current = true;
      window.location.href = '/login';
    }
  }, [location.pathname, location.search, user]);

  return <>{children}</>;
};
