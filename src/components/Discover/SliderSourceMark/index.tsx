import AnilistLogo from '@app/assets/services/anilist.svg';
import TraktLogo from '@app/assets/services/trakt.svg';
import { ArrowRightCircleIcon } from '@heroicons/react/24/outline';
import { DiscoverSliderType } from '@server/constants/discover';
import Link from 'next/link';
import type { ReactNode } from 'react';

export type DiscoverSliderSource = 'trakt' | 'anilist';

export const getDiscoverSliderSource = (
  type?: DiscoverSliderType
): DiscoverSliderSource | undefined => {
  switch (type) {
    case DiscoverSliderType.TRAKT_RECOMMENDATIONS:
    case DiscoverSliderType.TRAKT_WATCHLIST:
    case DiscoverSliderType.TRAKT_LIST:
    case DiscoverSliderType.TRAKT_HISTORY:
      return 'trakt';
    case DiscoverSliderType.ANILIST_TRENDING:
    case DiscoverSliderType.ANILIST_SEASON:
    case DiscoverSliderType.ANILIST_WATCHING:
    case DiscoverSliderType.ANILIST_PLANNING:
    case DiscoverSliderType.ANILIST_COMPLETED:
    case DiscoverSliderType.ANILIST_LIST:
      return 'anilist';
    default:
      return undefined;
  }
};

interface SliderSourceMarkProps {
  source: DiscoverSliderSource;
  className?: string;
}

const SliderSourceMark = ({
  source,
  className = 'h-5 w-5',
}: SliderSourceMarkProps) => {
  const isTrakt = source === 'trakt';
  const Logo = isTrakt ? TraktLogo : AnilistLogo;
  const label = isTrakt ? 'Trakt' : 'AniList';

  return (
    <span
      className="inline-flex shrink-0 items-center"
      title={label}
      aria-label={label}
    >
      <Logo className={className} />
    </span>
  );
};

export const SliderSourceTitle = ({
  source,
  children,
}: {
  source: DiscoverSliderSource;
  children: ReactNode;
}) => (
  <span className="inline-flex items-center gap-2">
    <SliderSourceMark source={source} className="h-7 w-7 sm:h-8 sm:w-8" />
    <span>{children}</span>
  </span>
);

export const DiscoverSliderTitle = ({
  href,
  source,
  children,
}: {
  href: string;
  source: DiscoverSliderSource;
  children: ReactNode;
}) => (
  <div className="slider-header">
    <Link href={href} className="slider-title">
      <SliderSourceMark source={source} />
      <span>{children}</span>
      <ArrowRightCircleIcon />
    </Link>
  </div>
);

export default SliderSourceMark;
