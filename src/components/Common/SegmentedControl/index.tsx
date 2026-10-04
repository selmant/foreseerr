import type { ComponentType, ReactNode, SVGProps } from 'react';
import { Link } from 'react-router';
import { twMerge } from 'tailwind-merge';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  /** Renders the option as a navigation link instead of a toggle button. */
  href?: string;
  'data-testid'?: string;
}

interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  value?: T;
  onChange?: (value: T) => void;
  ariaLabel: string;
  size?: 'md' | 'sm';
  /** Wrap options onto rows of this many; defaults to a single row. */
  columns?: number;
  className?: string;
  disabled?: boolean;
  wrapLabels?: boolean;
}

/**
 * One look for every mutually exclusive choice: page sub-navigation, view
 * switches, and scope tabs. Options with an `href` render as links inside a
 * `nav`; the rest render as pressed/unpressed buttons inside a group.
 */
const SegmentedControl = <T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'md',
  columns,
  className,
  disabled = false,
  wrapLabels = false,
}: SegmentedControlProps<T>) => {
  const isNav = options.some((option) => option.href);
  const containerClass = twMerge(
    'grid gap-1 rounded-xl border border-gray-700 bg-gray-900/70 p-1 shadow-sm',
    className
  );
  const style = {
    gridTemplateColumns: `repeat(${columns ?? options.length}, minmax(0, 1fr))`,
  };

  const items = options.map(
    ({ value: optionValue, label, icon: Icon, href, ...rest }) => {
      const active = optionValue === value;
      const itemClass = `flex items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50 ${wrapLabels ? 'whitespace-normal' : 'whitespace-nowrap'} ${
        size === 'sm' ? 'min-h-[36px] py-1.5' : 'min-h-[44px] py-2'
      } ${
        active
          ? 'bg-gray-700 text-white shadow ring-1 ring-white/10'
          : 'text-gray-400 hover:bg-gray-800 hover:text-gray-100'
      }`;
      const content = (
        <>
          {Icon ? (
            <Icon
              aria-hidden="true"
              className={`h-5 w-5 shrink-0 ${active ? 'text-indigo-400' : ''}`}
            />
          ) : null}
          <span
            className={
              wrapLabels
                ? 'min-w-0 whitespace-normal break-words text-center'
                : 'truncate'
            }
          >
            {label}
          </span>
        </>
      );

      return href ? (
        <Link
          key={optionValue}
          to={href}
          aria-current={active ? 'page' : undefined}
          className={itemClass}
          data-testid={rest['data-testid']}
        >
          {content}
        </Link>
      ) : (
        <button
          key={optionValue}
          type="button"
          aria-pressed={active}
          disabled={disabled}
          className={itemClass}
          data-testid={rest['data-testid']}
          onClick={() => onChange?.(optionValue)}
        >
          {content}
        </button>
      );
    }
  );

  return isNav ? (
    <nav aria-label={ariaLabel} className={containerClass} style={style}>
      {items}
    </nav>
  ) : (
    <div
      role="group"
      aria-label={ariaLabel}
      className={containerClass}
      style={style}
    >
      {items}
    </div>
  );
};

export default SegmentedControl;
