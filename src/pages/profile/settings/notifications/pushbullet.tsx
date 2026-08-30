import UserSettings from '@app/components/UserProfile/UserSettings';
import UserNotificationSettings from '@app/components/UserProfile/UserSettings/UserNotificationSettings';
import UserNotificationsPushbullet from '@app/components/UserProfile/UserSettings/UserNotificationSettings/UserNotificationsPushbullet';

const NotificationsPage = () => {
  return (
    <UserSettings>
      <UserNotificationSettings>
        <UserNotificationsPushbullet />
      </UserNotificationSettings>
    </UserSettings>
  );
};

export default NotificationsPage;
