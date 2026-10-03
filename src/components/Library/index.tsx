import Button from '@app/components/Common/Button';
import EmptyState from '@app/components/Common/EmptyState';
import Header from '@app/components/Common/Header';
import LinkButton from '@app/components/Common/LinkButton';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import LibraryInspector from '@app/components/Library/LibraryInspector';
import LibraryPlayCard from '@app/components/Library/LibraryPlayCard';
import { libraryMediaActionRefs } from '@app/components/Library/libraryPosterWatchMark';
import ManageSlideOver from '@app/components/ManageSlideOver';
import Slider from '@app/components/Slider';
import { TitleCardBatchProvider } from '@app/components/TitleCard/TitleCardBatchContext';
import defineMessages from '@app/utils/defineMessages';
import { registerLibraryShelfRevalidator } from '@app/utils/mediaActionInvalidation';
import {
  ExclamationTriangleIcon,
  LinkIcon,
  RectangleStackIcon,
  ServerIcon,
} from '@heroicons/react/24/outline';
import type {
  LibraryTitle,
  LibraryWatchNowResponse,
} from '@server/interfaces/api/libraryInterfaces';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import type { ComponentType, ReactNode, SVGProps } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';

const messages = defineMessages('components.Library', {
  library: 'Library',
  subtitle: 'Continue watching and jump back into what you already own.',
  notLinkedTitle: 'Jellyfin account not linked',
  notLinked:
    'Link your Jellyfin account in settings to see Continue Watching and Recently Added.',
  linkAccount: 'Link Account',
  serverUnreachable: 'Could not reach Jellyfin.',
  serverUnreachableDescription:
    'Check that your Jellyfin server is running, then try again.',
  retry: 'Retry',
  unsupportedTitle: 'Library needs Jellyfin',
  unsupported: 'Library shelves require a Jellyfin media server.',
  emptyShelvesTitle: 'Nothing to watch yet',
  emptyShelves:
    'Request titles from Discover, and they will appear here once Jellyfin adds them.',
  discover: 'Discover Titles',
});

const Library = () => {
  const intl = useIntl();
  const [inspectorItem, setInspectorItem] = useState<LibraryTitle | null>(null);
  const [managedTitle, setManagedTitle] = useState<
    | { data: MovieDetails; mediaType: 'movie' }
    | { data: TvDetails; mediaType: 'tv' }
    | null
  >(null);
  const [showManager, setShowManager] = useState(false);

  const {
    data: watchNow,
    error: watchNowError,
    mutate: revalidateWatchNow,
  } = useSWR<LibraryWatchNowResponse>('/api/v1/library/watch-now', {
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
    setShowManager(true);
  };

  const status = ((): {
    icon: ComponentType<SVGProps<SVGSVGElement>>;
    title: string;
    description?: string;
    action?: ReactNode;
  } | null => {
    if (watchNow?.code === 'not_linked') {
      return {
        icon: LinkIcon,
        title: intl.formatMessage(messages.notLinkedTitle),
        description: intl.formatMessage(messages.notLinked),
        action: (
          <LinkButton
            to="/profile/settings/linked-accounts"
            buttonType="primary"
          >
            <LinkIcon />
            <span>{intl.formatMessage(messages.linkAccount)}</span>
          </LinkButton>
        ),
      };
    }
    if (watchNow?.code === 'unsupported_media_server') {
      return {
        icon: ServerIcon,
        title: intl.formatMessage(messages.unsupportedTitle),
        description: intl.formatMessage(messages.unsupported),
      };
    }
    if (
      watchNow?.code === 'server_unreachable' ||
      (watchNowError && !watchNow?.shelves.length)
    ) {
      return {
        icon: ExclamationTriangleIcon,
        title: intl.formatMessage(messages.serverUnreachable),
        description: intl.formatMessage(messages.serverUnreachableDescription),
        action: (
          <Button onClick={() => void revalidateWatchNow()}>
            {intl.formatMessage(messages.retry)}
          </Button>
        ),
      };
    }
    if (watchNow && !watchNow.shelves.length && !watchNowError) {
      return {
        icon: RectangleStackIcon,
        title: intl.formatMessage(messages.emptyShelvesTitle),
        description: intl.formatMessage(messages.emptyShelves),
        action: (
          <LinkButton to="/" buttonType="primary">
            {intl.formatMessage(messages.discover)}
          </LinkButton>
        ),
      };
    }
    return null;
  })();

  const batchRefs = libraryMediaActionRefs(
    (watchNow?.shelves ?? []).flatMap((shelf) => shelf.items)
  );

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.library)} />
      <div className="mb-4">
        <Header subtext={intl.formatMessage(messages.subtitle)}>
          {intl.formatMessage(messages.library)}
        </Header>
      </div>

      {!watchNow && !watchNowError ? (
        <LoadingSpinner />
      ) : (
        <>
          {status ? (
            <div className="mt-6">
              <EmptyState
                icon={status.icon}
                title={status.title}
                description={status.description}
                action={status.action}
              />
            </div>
          ) : null}

          <TitleCardBatchProvider refs={batchRefs}>
            {(watchNow?.shelves ?? []).map((shelf) => (
              <div key={shelf.id}>
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
                      variant={shelf.id === 'continue' ? 'resume' : 'poster'}
                      surface="overview"
                      onOpen={setInspectorItem}
                    />
                  ))}
                />
              </div>
            ))}
          </TitleCardBatchProvider>
        </>
      )}

      <LibraryInspector
        item={inspectorItem}
        onClose={() => setInspectorItem(null)}
        onManage={openManager}
      />
      {managedTitle?.mediaType === 'movie' ? (
        <ManageSlideOver
          show={showManager}
          data={managedTitle.data}
          mediaType="movie"
          revalidate={revalidateLibrary}
          onClose={() => setShowManager(false)}
        />
      ) : managedTitle?.mediaType === 'tv' ? (
        <ManageSlideOver
          show={showManager}
          data={managedTitle.data}
          mediaType="tv"
          revalidate={revalidateLibrary}
          onClose={() => setShowManager(false)}
        />
      ) : null}
    </>
  );
};

export default Library;
