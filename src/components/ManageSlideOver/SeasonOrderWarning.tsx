import Alert from '@app/components/Common/Alert';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

import type { ServarrContext } from './servarrTypes';

const messages = defineMessages(
  'components.ManageSlideOver.SeasonOrderWarning',
  {
    title: 'This series uses {order} in Sonarr',
    otherOrder: 'another episode order',
    description:
      'Foreseerr maps seasons and episodes in aired order, so season numbers, requested episodes and availability shown here may not match what Sonarr has for this series.',
  }
);

/** A warning for a Sonarr series whose episode order is not aired order. */
const SeasonOrderWarning = ({
  order,
}: {
  order: ServarrContext['seasonOrder'];
}) => {
  const intl = useIntl();
  if (!order || order.type === 'official') return null;
  return (
    <Alert
      type="warning"
      title={intl.formatMessage(messages.title, {
        order: order.name ?? intl.formatMessage(messages.otherOrder),
      })}
    >
      {intl.formatMessage(messages.description)}
    </Alert>
  );
};

export default SeasonOrderWarning;
