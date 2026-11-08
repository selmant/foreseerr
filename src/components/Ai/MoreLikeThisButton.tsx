import LinkButton from '@app/components/Common/LinkButton';
import Tooltip from '@app/components/Common/Tooltip';
import useSettings from '@app/hooks/useSettings';
import defineMessages from '@app/utils/defineMessages';
import { LightBulbIcon } from '@heroicons/react/24/outline';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Ai.MoreLikeThisButton', {
  moreLikeThis: 'More like this',
  hint: 'AI picks that share what makes {title} work',
});

interface MoreLikeThisButtonProps {
  mediaType: 'movie' | 'tv';
  tmdbId: number;
  title: string;
}

/** Opens AI Picks seeded with this title, when AI is on. */
const MoreLikeThisButton = ({
  mediaType,
  tmdbId,
  title,
}: MoreLikeThisButtonProps) => {
  const intl = useIntl();
  const settings = useSettings();

  if (settings.currentSettings.aiEnabled !== true) {
    return null;
  }

  return (
    <Tooltip content={intl.formatMessage(messages.hint, { title })}>
      <LinkButton
        to={`/discover/ai?seed=${mediaType}:${tmdbId}`}
        buttonType="ghost"
        buttonSize="md"
        className="z-40 mr-2 min-h-[44px]"
        data-testid="more-like-this"
      >
        <LightBulbIcon className="text-indigo-300" />
        <span>{intl.formatMessage(messages.moreLikeThis)}</span>
      </LinkButton>
    </Tooltip>
  );
};

export default MoreLikeThisButton;
