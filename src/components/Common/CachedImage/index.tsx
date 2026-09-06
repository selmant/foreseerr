import useSettings from '@app/hooks/useSettings';
import { rewriteCachedImageSrc } from '@server/lib/imageproxySources';
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

  if (
    type !== 'tmdb' &&
    type !== 'tvdb' &&
    type !== 'avatar' &&
    type !== 'library'
  ) {
    return null;
  }

  const imageUrl = rewriteCachedImageSrc(src, currentSettings.cacheImages);

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
