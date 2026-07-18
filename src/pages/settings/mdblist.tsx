import SettingsLayout from '@app/components/Settings/SettingsLayout';
import SettingsMdblist from '@app/components/Settings/SettingsMdblist';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const MdbListSettingsPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);
  return (
    <SettingsLayout>
      <SettingsMdblist />
    </SettingsLayout>
  );
};

export default MdbListSettingsPage;
