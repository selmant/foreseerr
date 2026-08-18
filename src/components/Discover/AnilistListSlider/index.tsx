import AnilistSlider from '@app/components/Discover/AnilistSlider';
import { encodeURIExtraParams } from '@app/hooks/useDiscover';

interface AnilistListSliderProps {
  title: string;
  name: string;
  sliderKey: string;
  hideTitle?: boolean;
  onNewTitles?: (titleCount: number) => void;
}

const AnilistListSlider = ({
  title,
  name,
  sliderKey,
  hideTitle,
  onNewTitles,
}: AnilistListSliderProps) => {
  if (!name) {
    return null;
  }

  return (
    <AnilistSlider
      title={title}
      endpoint={`/api/v1/discover/anilist/list?name=${encodeURIExtraParams(name)}`}
      linkUrl={`/discover/anilist/list?name=${encodeURIComponent(name)}`}
      sliderKey={sliderKey}
      hideTitle={hideTitle}
      onNewTitles={onNewTitles}
    />
  );
};

export default AnilistListSlider;
