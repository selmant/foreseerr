import { Navigate } from 'react-router';

// Preserve bookmarks to the former standalone AI settings page.
const ProfileAiSettingsPage = () => (
  <Navigate to="/profile/settings/linked-accounts#ai-account" replace />
);

export default ProfileAiSettingsPage;
