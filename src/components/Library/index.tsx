import Header from '@app/components/Common/Header';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import LibraryInspector from '@app/components/Library/LibraryInspector';
import LibraryModeNav from '@app/components/Library/LibraryModeNav';
import LibraryPlayCard from '@app/components/Library/LibraryPlayCard';
import ManageSlideOver from '@app/components/ManageSlideOver';
import Slider from '@app/components/Slider';
import defineMessages from '@app/utils/defineMessages';
import { registerLibraryShelfRevalidator } from '@app/utils/mediaActionInvalidation';
import type {
  LibraryTitle,
  LibraryWatchNowResponse,
} from '@server/interfaces/api/libraryInterfaces';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import { useCallback, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';

const messages = defineMessages('components.Library', {
  library: 'Library',
  subtitle: 'Continue watching and jump back into what you already own.',
  notLinked:
    'Link your Jellyfin account in settings to see Continue Watching and Recently Added.',
  serverUnreachable: 'Could not reach Jellyfin.',
  unsupported: 'Watch Now shelves require a Jellyfin media server.',
  emptyShelves: 'Nothing to watch yet. Request titles from Discover.',
});

const Library = () => {
  const intl = useIntl();
  const [inspectorItem, setInspectorItem] = useState<LibraryTitle | null>(null);
  const [managedTitle, setManagedTitle] = useState<
    | { data: MovieDetails; mediaType: 'movie' }
    | { data: TvDetails; mediaType: 'tv' }
    | null
  >(null);

  const { data: watchNow, error: watchNowError } =
    useSWR<LibraryWatchNowResponse>('/api/v1/library/watch-now', {
      revalidateOnFocus: true,
    });

  const revalidateLibrary = useCallback(() => {
    if (managedTitle) {
      mutate(`/api/v1/${managedTitle.mediaType}/${managedTitle.data.id}`);
    }
    mutate('/api/v1/library/watch-now');
  }, [managedTitle]);

  useEffect(() => {
    return registerLibraryShelfRevalidator(revalidateLibrary);
  }, [revalidateLibrary]);

  const openManager = (data: MovieDetails | TvDetails) => {
    setInspectorItem(null);
    setManagedTitle(
      'title' in data ? { data, mediaType: 'movie' } : { data, mediaType: 'tv' }
    );
  };

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
      <LibraryModeNav />

      {!watchNow && !watchNowError ? (
        <LoadingSpinner />
      ) : (
        <>
          {statusMessage ? (
            <p className="mb-6 rounded-md border border-gray-700 bg-library-charcoal px-4 py-3 text-sm text-gray-300">
              {statusMessage}
            </p>
          ) : null}

          {(watchNow?.shelves ?? []).map((shelf) => (
            <div
              key={shelf.id}
              className={shelf.id === 'continue' ? 'mb-10' : 'mb-8'}
            >
              <div className="slider-header">
                <div className="slider-title">
                  <span className="library-display uppercase">
                    {shelf.title}
                  </span>
                </div>
              </div>
              <Slider
                sliderKey={`library-${shelf.id}`}
                isLoading={false}
                items={shelf.items.map((item) => (
                  <LibraryPlayCard
                    key={`${shelf.id}-${item.jellyfinItemId}`}
                    item={item}
                    variant={shelf.id === 'continue' ? 'resume' : 'poster'}
                    onOpen={setInspectorItem}
                    onManage={openManager}
                  />
                ))}
              />
            </div>
          ))}
        </>
      )}

      {!managedTitle ? (
        <LibraryInspector
          item={inspectorItem}
          onClose={() => setInspectorItem(null)}
          onManage={openManager}
        />
      ) : null}
      {managedTitle?.mediaType === 'movie' ? (
        <ManageSlideOver
          show
          data={managedTitle.data}
          mediaType="movie"
          revalidate={revalidateLibrary}
          onClose={() => setManagedTitle(null)}
        />
      ) : managedTitle?.mediaType === 'tv' ? (
        <ManageSlideOver
          show
          data={managedTitle.data}
          mediaType="tv"
          revalidate={revalidateLibrary}
          onClose={() => setManagedTitle(null)}
        />
      ) : null}
    </>
  );
};

export default Library;
