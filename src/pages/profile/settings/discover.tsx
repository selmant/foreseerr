import UserSettings from '@app/components/UserProfile/UserSettings';
import UserDiscoverSettings from '@app/components/UserProfile/UserSettings/UserDiscoverSettings';
import type { NextPage } from 'next';

const ProfileDiscoverSettingsPage: NextPage = () => {
  return (
    <UserSettings>
      <UserDiscoverSettings />
    </UserSettings>
  );
};

export default ProfileDiscoverSettingsPage;
