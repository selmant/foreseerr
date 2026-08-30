import useSettings from '@app/hooks/useSettings';
import type { CSSProperties, ImgHTMLAttributes } from 'react';

export type CachedImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  src: string;
  type: 'tmdb' | 'avatar' | 'tvdb' | 'library';
  fill?: boolean;
  priority?: boolean;
  unoptimized?: boolean;
};

const CachedImage = ({
  src,
  type,
  alt = '',
  fill,
  priority,
  style,
  className,
  loading,
  ...props
}: CachedImageProps) => {
  const { currentSettings } = useSettings();

  let imageUrl: string;

  if (type === 'tmdb') {
    imageUrl =
      currentSettings.cacheImages && !src.startsWith('/')
        ? src.replace(/^https:\/\/image\.tmdb\.org\//, '/imageproxy/tmdb/')
        : src;
  } else if (type === 'tvdb') {
    imageUrl =
      currentSettings.cacheImages && !src.startsWith('/')
        ? src.replace(
            /^https:\/\/artworks\.thetvdb\.com\//,
            '/imageproxy/tvdb/'
          )
        : src;
  } else if (type === 'avatar' || type === 'library') {
    imageUrl = src;
  } else {
    return null;
  }

  const imageStyle: CSSProperties = fill
    ? {
        position: 'absolute',
        height: '100%',
        width: '100%',
        inset: 0,
        objectFit: 'cover',
        ...style,
      }
    : (style ?? {});

  return (
    <img
      src={imageUrl}
      alt={alt}
      className={className}
      style={imageStyle}
      loading={priority ? 'eager' : loading}
      {...props}
    />
  );
};

export default CachedImage;
