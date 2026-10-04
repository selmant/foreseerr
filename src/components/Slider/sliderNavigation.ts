/** Advance by whole cards, including when a phone shows less than one full card. */
export const sliderTarget = ({
  scrollLeft,
  scrollWidth,
  viewportWidth,
  itemWidth,
  direction,
}: {
  scrollLeft: number;
  scrollWidth: number;
  viewportWidth: number;
  itemWidth: number;
  direction: 'previous' | 'next';
}) => {
  const width = itemWidth > 0 ? itemWidth : viewportWidth;
  if (width <= 0) return 0;
  const cards = Math.max(1, Math.floor(viewportWidth / width));
  const aligned = scrollLeft - (scrollLeft % width);
  return Math.max(
    0,
    Math.min(
      aligned + (direction === 'next' ? 1 : -1) * cards * width,
      Math.max(0, scrollWidth - viewportWidth)
    )
  );
};
