import { useEffect } from 'react';
import { useNavigate } from 'react-router';
import type { Permission, PermissionCheckOptions } from './useUser';
import { useUser } from './useUser';

const useRouteGuard = (
  permission: Permission | Permission[],
  options?: PermissionCheckOptions
): void => {
  const navigate = useNavigate();
  const { user, hasPermission } = useUser();

  useEffect(() => {
    if (user && !hasPermission(permission, options)) {
      navigate('/');
    }
  }, [user, permission, hasPermission, options]);
};

export default useRouteGuard;
