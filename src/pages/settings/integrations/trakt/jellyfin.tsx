import SettingsBetterTrakt from '@app/components/Settings/SettingsBetterTrakt';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const BetterTraktSettingsPage: NextPage = () => {
  useRouteGuard(Permission.ADMIN);

  return (
    <SettingsLayout>
      <SettingsBetterTrakt />
    </SettingsLayout>
  );
};

export default BetterTraktSettingsPage;
