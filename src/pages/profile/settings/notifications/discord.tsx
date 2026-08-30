import UserSettings from '@app/components/UserProfile/UserSettings';
import UserNotificationSettings from '@app/components/UserProfile/UserSettings/UserNotificationSettings';
import UserNotificationsDiscord from '@app/components/UserProfile/UserSettings/UserNotificationSettings/UserNotificationsDiscord';

const NotificationsPage = () => {
  return (
    <UserSettings>
      <UserNotificationSettings>
        <UserNotificationsDiscord />
      </UserNotificationSettings>
    </UserSettings>
  );
};

export default NotificationsPage;
