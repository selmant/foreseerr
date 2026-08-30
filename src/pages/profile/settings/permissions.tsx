import UserSettings from '@app/components/UserProfile/UserSettings';
import UserPermissions from '@app/components/UserProfile/UserSettings/UserPermissions';

const UserPermissionsPage = () => {
  return (
    <UserSettings>
      <UserPermissions />
    </UserSettings>
  );
};

export default UserPermissionsPage;
