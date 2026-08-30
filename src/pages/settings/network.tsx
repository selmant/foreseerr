import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsNetwork from '@app/components/Settings/SettingsNetwork';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';

const SettingsNetworkPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsNetwork />
    </SettingsLayout>
  );
};

export default SettingsNetworkPage;
