import ButtonWithDropdown from '@app/components/Common/ButtonWithDropdown';
import type { NativePlayTarget } from '@app/context/NativeRuntimeContext';
import { useNativeRuntime } from '@app/context/NativeRuntimeContext';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Common.PlayButton', {
  playbackOptions: 'Playback and trailer options',
});

interface PlayButtonProps {
  links: PlayButtonLink[];
}

export interface PlayButtonLink {
  text: string;
  url: string;
  svg: React.ReactNode;
  native?: Omit<NativePlayTarget, 'fallbackUrl' | 'label'>;
}

const PlayButton = ({ links }: PlayButtonProps) => {
  const intl = useIntl();
  const { play } = useNativeRuntime();
  if (!links || !links.length) {
    return null;
  }

  const renderLink = (link: PlayButtonLink) => {
    const onClick = link.native
      ? (event: React.MouseEvent<HTMLAnchorElement>) => {
          if (
            play({ ...link.native!, fallbackUrl: link.url, label: link.text })
          ) {
            event.preventDefault();
          }
        }
      : undefined;
    return { onClick };
  };

  return (
    <ButtonWithDropdown
      as="a"
      buttonType="ghost"
      dropdownLabel={intl.formatMessage(messages.playbackOptions)}
      text={
        <>
          {links[0].svg}
          <span>{links[0].text}</span>
        </>
      }
      href={links[0].url}
      target="_blank"
      {...renderLink(links[0])}
    >
      {links.length > 1 &&
        links.slice(1).map((link, i) => {
          return (
            <ButtonWithDropdown.Item
              key={`play-button-dropdown-item-${i}`}
              buttonType="ghost"
              href={link.url}
              target="_blank"
              {...renderLink(link)}
            >
              {link.svg}
              <span>{link.text}</span>
            </ButtonWithDropdown.Item>
          );
        })}
    </ButtonWithDropdown>
  );
};

export default PlayButton;
