import SettingsIntegrations from '@app/components/Settings/SettingsIntegrations';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';

const IntegrationsSettingsPage = () => {
  useRouteGuard(Permission.ADMIN);

  return (
    <SettingsLayout>
      <SettingsIntegrations />
    </SettingsLayout>
  );
};

export default IntegrationsSettingsPage;
