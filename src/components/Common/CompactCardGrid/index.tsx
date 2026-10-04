import { useLayoutEffect, useRef, type ReactElement } from 'react';

interface CompactCardGridProps {
  children: ReactElement[];
  /** Responsive columns; items retain their DOM and keyboard order. */
  columns: string;
  gap?: 12 | 16;
}

/** Let shorter cards make room for the next card without stretching their content. */
const CompactCardGrid = ({
  children,
  columns,
  gap = 16,
}: CompactCardGridProps) => {
  const gridRef = useRef<HTMLUListElement>(null);

  useLayoutEffect(() => {
    const cards = Array.from(gridRef.current?.children ?? [])
      .map((item) => item.firstElementChild)
      .filter((card): card is Element => Boolean(card));
    const sizeCard = (card: Element) => {
      // Four-pixel rows keep the columns on a small rhythm. The wrapper's
      // padding supplies the space between cards without adding row gaps.
      card.parentElement?.style.setProperty(
        '--card-grid-rows',
        String(Math.ceil((card.getBoundingClientRect().height + gap) / 4))
      );
    };
    const observer = new ResizeObserver((entries) => {
      entries.forEach(({ target }) => sizeCard(target));
    });
    cards.forEach((card) => {
      sizeCard(card);
      observer.observe(card);
    });
    return () => observer.disconnect();
  }, [children, gap]);

  return (
    <ul
      ref={gridRef}
      className={`grid auto-rows-[4px] items-start ${gap === 12 ? '-mb-3 gap-x-3' : '-mb-4 gap-x-4'} ${columns}`}
    >
      {children.map((card) => (
        <li
          key={card.key}
          className={`min-w-0 [grid-row-end:span_var(--card-grid-rows,40)] ${gap === 12 ? 'pb-3' : 'pb-4'}`}
        >
          {card}
        </li>
      ))}
    </ul>
  );
};

export default CompactCardGrid;
