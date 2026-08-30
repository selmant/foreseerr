import type { CSSProperties, ImgHTMLAttributes } from 'react';

type AppImageProps = ImgHTMLAttributes<HTMLImageElement> & {
  fill?: boolean;
  priority?: boolean;
};

const AppImage = ({
  fill,
  priority,
  alt = '',
  style,
  className,
  loading,
  ...props
}: AppImageProps) => {
  const imageStyle: CSSProperties = fill
    ? {
        position: 'absolute',
        height: '100%',
        width: '100%',
        inset: 0,
        objectFit: 'contain',
        ...style,
      }
    : (style ?? {});

  return (
    <img
      {...props}
      alt={alt}
      className={className}
      style={imageStyle}
      loading={priority ? 'eager' : loading}
    />
  );
};

export default AppImage;
