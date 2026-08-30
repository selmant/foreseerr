import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsMain from '@app/components/Settings/SettingsMain';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';

const SettingsMainPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsMain />
    </SettingsLayout>
  );
};

export default SettingsMainPage;
