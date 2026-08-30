import UserSettings from '@app/components/UserProfile/UserSettings';
import UserPermissions from '@app/components/UserProfile/UserSettings/UserPermissions';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';

const UserPermissionsPage = () => {
  useRouteGuard(Permission.MANAGE_USERS);
  return (
    <UserSettings>
      <UserPermissions />
    </UserSettings>
  );
};

export default UserPermissionsPage;
