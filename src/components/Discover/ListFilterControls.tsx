import Button from '@app/components/Common/Button';
import useDebouncedState from '@app/hooks/useDebouncedState';
import defineMessages from '@app/utils/defineMessages';
import {
  BarsArrowDownIcon,
  BarsArrowUpIcon,
} from '@heroicons/react/24/outline';
import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Discover.ListFilterControls', {
  ascending: 'Ascending',
  descending: 'Descending',
  sortDirection: 'Sort direction: {direction}',
});

/** Flips a provider list's sort between ascending and descending. */
export const SortDirectionButton = ({
  order,
  disabled,
  onChange,
}: {
  order?: 'asc' | 'desc';
  disabled?: boolean;
  onChange: (order: 'asc' | 'desc') => void;
}) => {
  const intl = useIntl();
  const direction = intl.formatMessage(
    order === 'asc' ? messages.ascending : messages.descending
  );
  return (
    <Button
      className="min-h-[44px] shrink-0"
      disabled={disabled}
      aria-label={intl.formatMessage(messages.sortDirection, { direction })}
      title={direction}
      onClick={() => onChange(order === 'asc' ? 'desc' : 'asc')}
    >
      {order === 'asc' ? <BarsArrowUpIcon /> : <BarsArrowDownIcon />}
    </Button>
  );
};

/** A row of toggle chips, one or many picked, like a provider's sidebar. */
export const ChipGroup = <T extends string>({
  label,
  options,
  selected,
  onChange,
  multiple = true,
  disabled = false,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  selected: readonly T[];
  onChange: (selected: T[]) => void;
  multiple?: boolean;
  disabled?: boolean;
}) => (
  <div
    className="flex flex-wrap gap-2"
    role={multiple ? 'group' : 'radiogroup'}
    aria-label={label}
  >
    {options.map((option) => {
      const active = selected.includes(option.value);
      return (
        <button
          key={option.value}
          type="button"
          role={multiple ? 'checkbox' : 'radio'}
          aria-checked={active}
          disabled={disabled}
          className={`min-h-[36px] rounded-full border px-3 text-sm transition disabled:opacity-50 ${
            active
              ? 'border-indigo-500 bg-indigo-600 text-white'
              : 'border-gray-600 bg-gray-800 text-gray-300 hover:bg-gray-700'
          }`}
          onClick={() => {
            if (!multiple) {
              onChange(active ? [] : [option.value]);
            } else {
              onChange(
                active
                  ? selected.filter((v) => v !== option.value)
                  : [...selected, option.value]
              );
            }
          }}
        >
          {option.label}
        </button>
      );
    })}
  </div>
);

/** A text filter that updates the route once typing pauses. */
export const DebouncedSearchInput = ({
  id,
  value,
  placeholder,
  onChange,
  className = 'min-h-[44px] w-full',
}: {
  id: string;
  value: string;
  placeholder?: string;
  onChange: (value?: string) => void;
  className?: string;
}) => {
  const [text, debounced, setText] = useDebouncedState(value, 500);
  const sent = useRef(value);

  // Follow the route when it changes elsewhere (e.g. "Clear").
  useEffect(() => {
    if (value !== sent.current) {
      sent.current = value;
      setText(value);
    }
  }, [value, setText]);

  useEffect(() => {
    const next = debounced.trim();
    if (next !== sent.current) {
      sent.current = next;
      onChange(next || undefined);
    }
  }, [debounced, onChange]);

  return (
    <input
      id={id}
      type="search"
      className={className}
      value={text}
      maxLength={200}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
    />
  );
};

export const FilterSectionTitle = ({ children }: { children: ReactNode }) => (
  <div className="mb-2 text-lg font-semibold">{children}</div>
);

/** Comma-separated route values. */
export const splitList = (value: unknown): string[] =>
  typeof value === 'string'
    ? value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    : [];
