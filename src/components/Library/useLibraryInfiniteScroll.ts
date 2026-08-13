import { useEffect, type RefObject } from 'react';

const useLibraryInfiniteScroll = (
  sentinel: RefObject<Element | null>,
  onLoadMore: () => void,
  enabled: boolean
) => {
  useEffect(() => {
    if (!enabled || !sentinel.current) {
      return undefined;
    }
    const node = sentinel.current;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onLoadMore();
        }
      },
      { rootMargin: '800px 0px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, onLoadMore, sentinel]);
};

export default useLibraryInfiniteScroll;
