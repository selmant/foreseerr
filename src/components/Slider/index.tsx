import ShowMoreCard, {
  type ShowMoreCardProps,
} from '@app/components/MediaSlider/ShowMoreCard';
import TitleCard from '@app/components/TitleCard';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { useSpring } from '@react-spring/web';
import { debounce } from 'lodash';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useIntl } from 'react-intl';
import { sliderTarget } from './sliderNavigation';

const messages = defineMessages('components.Slider', {
  titles: 'Titles',
  previous: 'Previous titles in {shelf}',
  next: 'Next titles in {shelf}',
  previousTitles: 'Previous titles',
  nextTitles: 'Next titles',
  keyboardHelp: 'Use the left and right arrow keys to browse this shelf.',
});

interface SliderProps {
  sliderKey: string;
  items?: JSX.Element[];
  isLoading: boolean;
  isEmpty?: boolean;
  emptyMessage?: React.ReactNode;
  placeholder?: React.ReactNode;
  ariaLabel?: string;
  /** End-of-shelf navigation to a complete browse page. Hidden for empty/loading shelves. */
  seeMore?: Omit<ShowMoreCardProps, 'title'> & { title?: string };
}

enum Direction {
  RIGHT,
  LEFT,
}

const Slider = ({
  sliderKey,
  items,
  isLoading,
  isEmpty = false,
  emptyMessage,
  placeholder = <TitleCard.Placeholder />,
  ariaLabel,
  seeMore,
}: SliderProps) => {
  const intl = useIntl();
  const instructionsId = useId();
  const shelfLabel = ariaLabel ?? intl.formatMessage(messages.titles);
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollPos, setScrollPos] = useState({ isStart: true, isEnd: false });

  const handleScroll = useCallback(() => {
    const margin = 5;
    const scrollWidth = containerRef.current?.scrollWidth ?? 0;
    const clientWidth =
      containerRef.current?.getBoundingClientRect().width ?? 0;
    const scrollPosition = containerRef.current?.scrollLeft ?? 0;

    if (!items || items?.length === 0) {
      setScrollPos({ isStart: true, isEnd: true });
    } else if (clientWidth >= scrollWidth) {
      setScrollPos({ isStart: true, isEnd: true });
    } else if (
      scrollPosition >=
      (containerRef.current?.scrollWidth ?? 0) - clientWidth - margin
    ) {
      setScrollPos({ isStart: false, isEnd: true });
    } else if (scrollPosition > margin) {
      setScrollPos({ isStart: false, isEnd: false });
    } else {
      setScrollPos({ isStart: true, isEnd: false });
    }
  }, [items]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const debouncedScroll = useCallback(
    debounce(() => handleScroll(), 50),
    [handleScroll]
  );

  useEffect(() => {
    const handleResize = () => {
      debouncedScroll();
    };

    window.addEventListener('resize', handleResize, { passive: true });

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [debouncedScroll]);

  useEffect(() => {
    handleScroll();
  }, [items, handleScroll]);

  const onScroll = () => {
    debouncedScroll();
  };

  const [, setX] = useSpring(() => ({
    from: { x: 0 },
    to: { x: 0 },
  }));

  const slide = async (direction: Direction) => {
    const clientWidth =
      containerRef.current?.getBoundingClientRect().width ?? 0;
    const cardWidth =
      containerRef.current?.firstElementChild?.getBoundingClientRect().width ??
      0;
    const scrollPosition = containerRef.current?.scrollLeft ?? 0;
    const target = sliderTarget({
      scrollLeft: scrollPosition,
      scrollWidth: containerRef.current?.scrollWidth ?? 0,
      viewportWidth: clientWidth,
      itemWidth: cardWidth,
      direction: direction === Direction.LEFT ? 'previous' : 'next',
    });

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      if (containerRef.current) containerRef.current.scrollLeft = target;
      handleScroll();
      return;
    }

    if (direction === Direction.LEFT) {
      const newX = target;
      await setX.start({
        from: { x: scrollPosition },
        to: { x: newX },
        onChange: (results) => {
          if (containerRef.current) {
            containerRef.current.scrollLeft = results.value.x;
          }
        },
        reset: true,
        config: { friction: 60, tension: 500, velocity: 20 },
      })[0];

      if (newX === 0) {
        setScrollPos({ isStart: true, isEnd: false });
      } else {
        setScrollPos({ isStart: false, isEnd: false });
      }
    } else if (direction === Direction.RIGHT) {
      const newX = target;
      await setX.start({
        from: { x: scrollPosition },
        to: { x: newX },
        onChange: (results) => {
          if (containerRef.current) {
            containerRef.current.scrollLeft = results.value.x;
          }
        },
        reset: true,
        config: { friction: 60, tension: 500, velocity: 20 },
      })[0];

      if (newX >= (containerRef.current?.scrollWidth ?? 0) - clientWidth) {
        setScrollPos({ isStart: false, isEnd: true });
      } else {
        setScrollPos({ isStart: false, isEnd: false });
      }
    }
  };

  return (
    <div className="relative" data-testid="media-slider">
      <div className="absolute right-0 -mt-12 flex gap-1 text-gray-400">
        <button
          className="flex h-11 w-11 items-center justify-center rounded-lg transition hover:bg-gray-800 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:cursor-default disabled:text-gray-600 disabled:hover:bg-transparent"
          onClick={() => slide(Direction.LEFT)}
          disabled={scrollPos.isStart}
          type="button"
          aria-label={intl.formatMessage(
            ariaLabel ? messages.previous : messages.previousTitles,
            {
              shelf: shelfLabel,
            }
          )}
        >
          <ChevronLeftIcon className="h-6 w-6" />
        </button>
        <button
          className="flex h-11 w-11 items-center justify-center rounded-lg transition hover:bg-gray-800 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 disabled:cursor-default disabled:text-gray-600 disabled:hover:bg-transparent"
          onClick={() => slide(Direction.RIGHT)}
          disabled={scrollPos.isEnd}
          type="button"
          aria-label={intl.formatMessage(
            ariaLabel ? messages.next : messages.nextTitles,
            { shelf: shelfLabel }
          )}
        >
          <ChevronRightIcon className="h-6 w-6" />
        </button>
      </div>
      <p id={instructionsId} className="sr-only">
        {intl.formatMessage(messages.keyboardHelp)}
      </p>
      <div
        className="hide-scrollbar relative -my-2 -ml-4 -mr-4 flex items-stretch overflow-y-auto overflow-x-scroll overscroll-x-contain whitespace-nowrap px-2 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500"
        ref={containerRef}
        onScroll={onScroll}
        role="list"
        aria-label={shelfLabel}
        aria-describedby={instructionsId}
        tabIndex={items?.length ? 0 : -1}
      >
        {items?.map((item, index) => (
          <div
            key={`${sliderKey}-${index}`}
            className="shrink-0 px-2"
            role="listitem"
          >
            {item}
          </div>
        ))}
        {seeMore && !isLoading && !isEmpty && Boolean(items?.length) && (
          <div className="flex shrink-0 px-2" role="listitem">
            <ShowMoreCard {...seeMore} title={seeMore.title ?? shelfLabel} />
          </div>
        )}
        {isLoading &&
          [...Array(10)].map((_item, i) => (
            <div key={`placeholder-${i}`} className="shrink-0 px-2">
              {placeholder}
            </div>
          ))}
        {isEmpty && (
          <div className="mb-16 mt-16 w-full text-center font-medium text-gray-400">
            {emptyMessage
              ? emptyMessage
              : intl.formatMessage(globalMessages.noresults)}
          </div>
        )}
      </div>
    </div>
  );
};

export default Slider;
