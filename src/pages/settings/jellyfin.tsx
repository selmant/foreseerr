import SettingsJellyfin from '@app/components/Settings/SettingsJellyfin';
import SettingsLayout from '@app/components/Settings/SettingsLayout';
import useRouteGuard from '@app/hooks/useRouteGuard';
import { Permission } from '@app/hooks/useUser';

const JellyfinSettingsPage = () => {
  useRouteGuard(Permission.MANAGE_SETTINGS);
  return (
    <SettingsLayout>
      <SettingsJellyfin />
    </SettingsLayout>
  );
};

export default JellyfinSettingsPage;
