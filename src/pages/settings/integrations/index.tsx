import SettingsIntegrations from '@app/components/Settings/SettingsIntegrations';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const IntegrationsSettingsPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);

  return (
    <SettingsLayout>
      <SettingsIntegrations />
    </SettingsLayout>
  );
};

export default IntegrationsSettingsPage;
