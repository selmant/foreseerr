import { StarIcon as StarOutline } from '@heroicons/react/24/outline';
import { StarIcon as StarSolid } from '@heroicons/react/24/solid';

/** The rating controls use half-star increments while providers store /10 values. */
export const STAR_STEPS = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5] as const;

export function starsToTrakt(stars: number): number {
  return Math.max(1, Math.min(10, Math.round(stars * 2)));
}

export function nearestStarStep(stars: number): number {
  return STAR_STEPS.reduce((best, step) =>
    Math.abs(step - stars) < Math.abs(best - stars) ? step : best
  );
}

export function starFillAmount(displayStars: number, index: number): number {
  const remaining = displayStars - index;
  if (remaining >= 1) return 1;
  if (remaining >= 0.5) return 0.5;
  return 0;
}

interface RatingStarProps {
  index: number;
  fill: number;
  disabled: boolean;
  onHover: (stars: number) => void;
  onPick: (stars: number) => void;
  stopPropagation?: boolean;
}

/** A half-clickable star used by both compact cards and detail-page actions. */
export const RatingStar = ({
  index,
  fill,
  disabled,
  onHover,
  onPick,
  stopPropagation = false,
}: RatingStarProps) => {
  const halfValue = index + 0.5;
  const fullValue = index + 1;

  const pick = (event: React.MouseEvent, value: number) => {
    if (stopPropagation) {
      event.preventDefault();
      event.stopPropagation();
    }
    onPick(value);
  };

  return (
    <span className="relative inline-flex h-7 w-7 shrink-0">
      <StarOutline className="absolute inset-0 h-7 w-7 text-gray-500" />
      {fill > 0 && (
        <span
          className="absolute inset-0 overflow-hidden"
          style={{ width: `${fill * 100}%` }}
        >
          <StarSolid className="h-7 w-7 text-amber-300" />
        </span>
      )}
      <button
        type="button"
        aria-label={`${starsToTrakt(halfValue)}/10`}
        disabled={disabled}
        className="absolute inset-y-0 left-0 z-10 w-1/2 cursor-pointer disabled:cursor-wait"
        onMouseEnter={() => onHover(halfValue)}
        onFocus={() => onHover(halfValue)}
        onClick={(event) => pick(event, halfValue)}
      />
      <button
        type="button"
        aria-label={`${starsToTrakt(fullValue)}/10`}
        disabled={disabled}
        className="absolute inset-y-0 right-0 z-10 w-1/2 cursor-pointer disabled:cursor-wait"
        onMouseEnter={() => onHover(fullValue)}
        onFocus={() => onHover(fullValue)}
        onClick={(event) => pick(event, fullValue)}
      />
    </span>
  );
};
