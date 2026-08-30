import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsMapping from '@app/components/Settings/SettingsMapping';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';

const SettingsMappingPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsMapping />
    </SettingsLayout>
  );
};

export default SettingsMappingPage;
