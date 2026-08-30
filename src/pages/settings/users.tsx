import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsUsers from '@app/components/Settings/SettingsUsers';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';

const SettingsUsersPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsUsers />
    </SettingsLayout>
  );
};

export default SettingsUsersPage;
