import useSearchInput from '@app/hooks/useSearchInput';
import defineMessages from '@app/utils/defineMessages';
import { XCircleIcon } from '@heroicons/react/24/outline';
import { MagnifyingGlassIcon } from '@heroicons/react/24/solid';
import { useRef } from 'react';
import { useIntl } from 'react-intl';

const messages = defineMessages('components.Layout.SearchInput', {
  searchPlaceholder: 'Search Movies & Series',
  clearSearch: 'Clear search',
  searchLabel: 'Search movies and series',
});

const SearchInput = () => {
  const intl = useIntl();
  const { searchValue, setSearchValue, setIsOpen, clear, submit } =
    useSearchInput();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-1">
      <form
        className="flex w-full"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          if (submit())
            requestAnimationFrame(() =>
              document
                .querySelector<HTMLElement>('main')
                ?.focus({ preventScroll: true })
            );
        }}
      >
        <label htmlFor="search_field" className="sr-only">
          {intl.formatMessage(messages.searchLabel)}
        </label>
        <div className="relative flex w-full items-center text-white focus-within:text-gray-200">
          <div className="pointer-events-none absolute inset-y-0 left-4 flex items-center">
            <MagnifyingGlassIcon aria-hidden="true" className="h-5 w-5" />
          </div>
          <input
            ref={inputRef}
            id="search_field"
            className="block min-h-11 w-full rounded-full border border-gray-600 bg-gray-900/80 py-2 pl-10 pr-12 text-white placeholder-gray-300 hover:border-gray-500 focus:border-indigo-400 focus:bg-gray-900 focus:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 sm:text-base"
            placeholder={intl.formatMessage(messages.searchPlaceholder)}
            type="search"
            autoComplete="off"
            enterKeyHint="search"
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            onFocus={() => setIsOpen(true)}
            onBlur={() => {
              if (searchValue === '') {
                clear();
              }
            }}
          />
          {searchValue.length > 0 && (
            <button
              type="button"
              aria-label={intl.formatMessage(messages.clearSearch)}
              className="absolute inset-y-0 right-0 flex min-h-11 min-w-11 items-center justify-center rounded-full text-gray-400 transition hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
              onClick={() => {
                clear();
                requestAnimationFrame(() =>
                  inputRef.current?.focus({ preventScroll: true })
                );
              }}
            >
              <XCircleIcon aria-hidden="true" className="h-5 w-5" />
            </button>
          )}
        </div>
      </form>
    </div>
  );
};

export default SearchInput;
