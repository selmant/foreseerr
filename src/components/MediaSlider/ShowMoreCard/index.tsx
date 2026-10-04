import CachedImage from '@app/components/Common/CachedImage';
import defineMessages from '@app/utils/defineMessages';
import { ArrowRightCircleIcon } from '@heroicons/react/24/solid';
import { useIntl } from 'react-intl';
import { Link } from 'react-router';

const messages = defineMessages('components.MediaSlider.ShowMoreCard', {
  seemore: 'See More',
  seeMoreIn: 'See more in {shelf}',
});

export interface ShowMoreCardProps {
  url: string;
  title: string;
  posters?: (string | undefined)[];
  imageType?: 'tmdb' | 'library';
  layout?: 'poster' | 'resume' | 'request';
  label?: string;
}

const ShowMoreCard = ({
  url,
  title,
  posters = [],
  imageType = 'tmdb',
  layout = 'poster',
  label,
}: ShowMoreCardProps) => {
  const intl = useIntl();
  const artwork = posters
    .filter((poster): poster is string => Boolean(poster))
    .slice(0, 4);

  return (
    <Link
      to={url}
      aria-label={
        label
          ? `${label}: ${title}`
          : intl.formatMessage(messages.seeMoreIn, { shelf: title })
      }
      className={`group relative flex flex-col items-center justify-center overflow-hidden rounded-xl bg-gray-800 p-3 text-white shadow-lg ring-1 ring-gray-700 transition duration-150 hover:bg-gray-700 hover:ring-gray-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 motion-reduce:transition-none ${
        layout === 'resume'
          ? 'h-full min-h-28 w-72 sm:w-80'
          : layout === 'request'
            ? 'h-full min-h-28 w-72 sm:w-96'
            : 'aspect-[2/3] w-36 md:w-44'
      }`}
    >
      <div
        aria-hidden
        className="absolute inset-2 grid grid-cols-2 grid-rows-2 gap-2 opacity-25"
      >
        {artwork.map((poster, index) => (
          <div
            key={`${poster}-${index}`}
            className="relative overflow-hidden rounded-md"
          >
            <CachedImage
              type={imageType}
              src={
                poster.startsWith('/') && imageType === 'tmdb'
                  ? `https://image.tmdb.org/t/p/w300_and_h450_face${poster}`
                  : poster
              }
              alt=""
              fill
              loading="lazy"
              className="object-cover"
            />
          </div>
        ))}
      </div>
      <div className="relative flex flex-col items-center text-center">
        <ArrowRightCircleIcon
          aria-hidden
          className="h-14 w-14 transition-transform group-hover:translate-x-1 motion-reduce:transform-none"
        />
        <span className="mt-2 whitespace-normal font-extrabold">
          {label ?? intl.formatMessage(messages.seemore)}
        </span>
      </div>
    </Link>
  );
};

export default ShowMoreCard;
