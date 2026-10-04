import EmptyState from '@app/components/Common/EmptyState';
import Header from '@app/components/Common/Header';
import LinkButton from '@app/components/Common/LinkButton';
import PageTitle from '@app/components/Common/PageTitle';
import {
  SliderSourceTitle,
  type DiscoverSliderSource,
} from '@app/components/Discover/SliderSourceMark';
import defineMessages from '@app/utils/defineMessages';
import {
  ExclamationTriangleIcon,
  LinkIcon,
  Squares2X2Icon,
} from '@heroicons/react/24/outline';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.DiscoverProviderMessage', {
  linkedAccounts: 'Linked Accounts',
  sources: 'Browse list sources',
});

/**
 * Full-page state for provider-backed discover pages that cannot show a list
 * yet, such as an unlinked account or a missing list URL.
 */
const DiscoverProviderMessage = ({
  title,
  source,
  message,
  linkAccount = false,
}: {
  title: string;
  source: DiscoverSliderSource;
  message: string;
  linkAccount?: boolean;
}) => {
  const intl = useIntl();
  return (
    <>
      <PageTitle title={title} />
      <div className="mb-5 mt-1 [&_h2]:whitespace-normal [&_h2]:break-words">
        <Header>
          <SliderSourceTitle source={source}>{title}</SliderSourceTitle>
        </Header>
      </div>
      <EmptyState
        icon={linkAccount ? LinkIcon : ExclamationTriangleIcon}
        title={message}
        action={
          linkAccount ? (
            <LinkButton
              to="/profile/settings/linked-accounts"
              buttonType="primary"
              className="min-h-[44px]"
            >
              <LinkIcon />
              <span>{intl.formatMessage(messages.linkedAccounts)}</span>
            </LinkButton>
          ) : (
            <LinkButton to="/discover/sources" className="min-h-[44px]">
              <Squares2X2Icon />
              <span>{intl.formatMessage(messages.sources)}</span>
            </LinkButton>
          )
        }
      />
    </>
  );
};

export default DiscoverProviderMessage;
