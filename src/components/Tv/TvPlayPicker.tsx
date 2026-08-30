import type { PlayButtonLink } from '@app/components/Common/PlayButton';
import TvFocusable from '@app/components/Tv/TvFocusable';
import TvOverlay from '@app/components/Tv/TvOverlay';
import { useNativeRuntime } from '@app/context/NativeRuntimeContext';
import defineMessages from '@app/utils/defineMessages';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Tv.TvPlayPicker', {
  title: 'Play',
});

interface TvPlayPickerProps {
  links: PlayButtonLink[];
  onClose: () => void;
}

const TvPlayPicker = ({ links, onClose }: TvPlayPickerProps) => {
  const intl = useIntl();
  const { play } = useNativeRuntime();

  const activate = (link: PlayButtonLink) => {
    if (
      link.native &&
      play({
        ...link.native,
        fallbackUrl: link.url,
        label: link.text,
      })
    ) {
      onClose();
      return;
    }
    window.open(link.url, '_blank', 'noopener,noreferrer');
    onClose();
  };

  return (
    <TvOverlay title={intl.formatMessage(messages.title)} onClose={onClose}>
      {links.map((link) => (
        <TvFocusable key={link.url} onEnterPress={() => activate(link)}>
          <button
            type="button"
            className="tv-focus-target flex min-h-14 w-full items-center gap-3 rounded-lg bg-gray-800 px-4 text-left text-lg text-white"
            onClick={() => activate(link)}
          >
            {link.svg}
            <span>{link.text}</span>
          </button>
        </TvFocusable>
      ))}
    </TvOverlay>
  );
};

export default TvPlayPicker;
