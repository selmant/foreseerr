import type { ReactNode } from 'react';
import { useInView } from 'react-intersection-observer';

const PLACEHOLDER_HEIGHT_PX = 304;
const PREFETCH_MARGIN = '900px 0px';

interface DiscoverSliderRowProps {
  children: ReactNode;
  eager?: boolean;
}

const DiscoverSliderRow = ({
  children,
  eager = false,
}: DiscoverSliderRowProps) => {
  const { ref, inView } = useInView({
    triggerOnce: true,
    rootMargin: PREFETCH_MARGIN,
  });

  return (
    <div ref={ref}>
      {eager || inView ? (
        children
      ) : (
        <div
          className="mb-4"
          style={{ minHeight: PLACEHOLDER_HEIGHT_PX }}
          aria-hidden
        />
      )}
    </div>
  );
};

export default DiscoverSliderRow;
