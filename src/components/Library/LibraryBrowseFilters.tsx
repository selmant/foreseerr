import LibraryBrowseToolbar, {
  SORT_OPTIONS,
} from '@app/components/Library/LibraryBrowseToolbar';
import defineMessages from '@app/utils/defineMessages';
import type {
  LibraryDensity,
  ParsedLibraryBrowseQuery,
} from '@server/lib/libraryBrowseQuery';
import { useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Library.LibraryBrowseFilters', {
  title: 'Filters and sort',
  close: 'Done',
});

interface LibraryBrowseFiltersProps {
  open: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  state: ParsedLibraryBrowseQuery;
  density: LibraryDensity;
  genres: string[];
  yearMin?: number;
  yearMax?: number;
  resultCount?: number;
  onChange: (patch: Partial<ParsedLibraryBrowseQuery>) => void;
  onDensityChange: (density: LibraryDensity) => void;
  onReset: () => void;
  onClose: () => void;
}

const LibraryBrowseFilters = ({
  open,
  onClose,
  ...toolbarProps
}: LibraryBrowseFiltersProps) => {
  const intl = useIntl();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      dialogRef.current?.focus();
    }
  }, [open]);

  if (!open) {
    return null;
  }

  return (
    /* eslint-disable jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */
    <div className="fixed inset-0 z-40 bg-black/60 lg:hidden" onClick={onClose}>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={intl.formatMessage(messages.title)}
        tabIndex={-1}
        className="library-sheet absolute inset-x-0 bottom-0 max-h-[90vh] overflow-y-auto rounded-t-2xl bg-library-navy p-4"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            onClose();
          }
        }}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="library-display text-2xl uppercase text-white">
            {intl.formatMessage(messages.title)}
          </h2>
          <button
            type="button"
            className="min-h-11 rounded-md px-3 text-sm text-indigo-300"
            onClick={onClose}
          >
            {intl.formatMessage(messages.close)}
          </button>
        </div>
        <LibraryBrowseToolbar {...toolbarProps} onOpenFilters={undefined} />
      </div>
    </div>
  );
};

export { SORT_OPTIONS };
export default LibraryBrowseFilters;
