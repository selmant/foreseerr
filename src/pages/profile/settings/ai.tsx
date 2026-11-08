import UserSettings from '@app/components/UserProfile/UserSettings';
import UserAiSettings from '@app/components/UserProfile/UserSettings/UserAiSettings';

// Only the signed-in user's own page: AI connections are personal, so
// there is no /users/:id variant for admins.
const ProfileAiSettingsPage = () => {
  return (
    <UserSettings>
      <UserAiSettings />
    </UserSettings>
  );
};

export default ProfileAiSettingsPage;
