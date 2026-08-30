import UserSettings from '@app/components/UserProfile/UserSettings';
import UserNotificationSettings from '@app/components/UserProfile/UserSettings/UserNotificationSettings';
import UserWebPushSettings from '@app/components/UserProfile/UserSettings/UserNotificationSettings/UserNotificationsWebPush';

const WebPushProfileNotificationsPage = () => {
  return (
    <UserSettings>
      <UserNotificationSettings>
        <UserWebPushSettings />
      </UserNotificationSettings>
    </UserSettings>
  );
};

export default WebPushProfileNotificationsPage;
