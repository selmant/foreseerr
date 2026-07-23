import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsRequestRouting from '@app/components/Settings/SettingsRequestRouting';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const RequestRoutingSettingsPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsRequestRouting />
    </SettingsLayout>
  );
};

export default RequestRoutingSettingsPage;
