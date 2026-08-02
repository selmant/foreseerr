import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import LibraryPlayCard from '@app/components/Library/LibraryPlayCard';
import Slider from '@app/components/Slider';
import defineMessages from '@app/utils/defineMessages';
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import type {
  LibraryAvailableResponse,
  LibraryWatchNowResponse,
} from '@server/interfaces/api/libraryInterfaces';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Library', {
  library: 'Library',
  subtitle: 'Continue watching and browse what you already own.',
  notLinked:
    'Link your Jellyfin account in settings to see Continue Watching and Recently Added.',
  serverUnreachable:
    'Could not reach Jellyfin. Available titles from Foreseer still appear below when present.',
  unsupported: 'Watch Now shelves require a Jellyfin media server.',
  emptyShelves: 'Nothing to watch yet. Request titles from Discover.',
  available: 'Available in Library',
  searchPlaceholder: 'Search your library…',
  noResults: 'No matching titles.',
  loadFailed: 'Could not load library titles. Try again in a moment.',
  movies: 'Movies',
  series: 'Series',
  all: 'All',
});

const Library = () => {
  const intl = useIntl();
  const [query, setQuery] = useState('');
  const [mediaType, setMediaType] = useState<'all' | 'movie' | 'tv'>('all');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  useEffect(() => {
    const handle = window.setTimeout(
      () => setDebouncedQuery(query.trim()),
      300
    );
    return () => window.clearTimeout(handle);
  }, [query]);

  const { data: watchNow, error: watchNowError } =
    useSWR<LibraryWatchNowResponse>('/api/v1/library/watch-now', {
      revalidateOnFocus: true,
    });

  const availableKey = debouncedQuery
    ? `/api/v1/library/search?q=${encodeURIComponent(debouncedQuery)}&take=24${
        mediaType !== 'all' ? `&mediaType=${mediaType}` : ''
      }`
    : `/api/v1/library/available?take=24&skip=0${
        mediaType !== 'all' ? `&mediaType=${mediaType}` : ''
      }`;

  const { data: available, error: availableError } =
    useSWR<LibraryAvailableResponse>(availableKey);

  const statusMessage = (() => {
    if (watchNow?.code === 'not_linked') {
      return intl.formatMessage(messages.notLinked);
    }
    if (watchNow?.code === 'unsupported_media_server') {
      return intl.formatMessage(messages.unsupported);
    }
    if (watchNow?.code === 'server_unreachable') {
      return intl.formatMessage(messages.serverUnreachable);
    }
    if (watchNow && !watchNow.shelves.length && !watchNowError) {
      return intl.formatMessage(messages.emptyShelves);
    }
    return null;
  })();

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.library)} />
      <div className="mb-6">
        <Header>{intl.formatMessage(messages.library)}</Header>
        <p className="mt-1 text-sm text-gray-400">
          {intl.formatMessage(messages.subtitle)}
        </p>
      </div>

      {!watchNow && !watchNowError ? (
        <LoadingSpinner />
      ) : (
        <>
          {statusMessage ? (
            <p className="mb-6 rounded-md border border-gray-700 bg-gray-800/60 px-4 py-3 text-sm text-gray-300">
              {statusMessage}
            </p>
          ) : null}

          {(watchNow?.shelves ?? []).map((shelf) => (
            <div key={shelf.id} className="mb-8">
              <div className="slider-header">
                <div className="slider-title">
                  <span>{shelf.title}</span>
                </div>
              </div>
              <Slider
                sliderKey={`library-${shelf.id}`}
                isLoading={false}
                items={shelf.items.map((item) => (
                  <LibraryPlayCard
                    key={`${shelf.id}-${item.jellyfinItemId}`}
                    item={item}
                  />
                ))}
              />
            </div>
          ))}
        </>
      )}

      <div className="mb-4 mt-2">
        <div className="slider-header">
          <div className="slider-title">
            <span>{intl.formatMessage(messages.available)}</span>
          </div>
        </div>
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={intl.formatMessage(messages.searchPlaceholder)}
              className="w-full rounded-md border border-gray-700 bg-gray-800 py-2 pl-9 pr-3 text-sm text-gray-100 placeholder:text-gray-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
          </div>
          <div className="flex gap-2">
            {(
              [
                ['all', messages.all],
                ['movie', messages.movies],
                ['tv', messages.series],
              ] as const
            ).map(([value, msg]) => (
              <button
                key={value}
                type="button"
                onClick={() => setMediaType(value)}
                className={`rounded-md px-3 py-1.5 text-sm ${
                  mediaType === value
                    ? 'bg-indigo-600 text-white'
                    : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                }`}
              >
                {intl.formatMessage(msg)}
              </button>
            ))}
          </div>
        </div>

        {!available && !availableError ? (
          <LoadingSpinner />
        ) : availableError ? (
          <p className="text-sm text-red-400">
            {intl.formatMessage(messages.loadFailed)}
          </p>
        ) : !available?.results.length ? (
          <p className="text-sm text-gray-400">
            {intl.formatMessage(messages.noResults)}
          </p>
        ) : (
          <div className="flex flex-wrap gap-4">
            {available.results.map((item) => (
              <LibraryPlayCard
                key={`available-${item.jellyfinItemId}-${item.tmdbId ?? 0}`}
                item={item}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
};

export default Library;
