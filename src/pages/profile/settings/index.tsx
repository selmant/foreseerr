import UserSettings from '@app/components/UserProfile/UserSettings';
import UserGeneralSettings from '@app/components/UserProfile/UserSettings/UserGeneralSettings';

const UserSettingsPage = () => {
  return (
    <UserSettings>
      <UserGeneralSettings />
    </UserSettings>
  );
};

export default UserSettingsPage;
