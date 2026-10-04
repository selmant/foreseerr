import Alert from '@app/components/Common/Alert';
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
import useHashNavigation from '@app/hooks/useHashNavigation';
import defineMessages from '@app/utils/defineMessages';
import { registerLibraryShelfRevalidator } from '@app/utils/mediaActionInvalidation';
import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
  LinkIcon,
  MagnifyingGlassIcon,
  RectangleStackIcon,
  ServerIcon,
} from '@heroicons/react/24/outline';
import type {
  LibraryShelf,
  LibraryTitle,
  LibraryWatchNowResponse,
} from '@server/interfaces/api/libraryInterfaces';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import type { ComponentType, ReactNode, SVGProps } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { Link } from 'react-router';
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
  unsupported:
    'Library shelves require a Jellyfin media server. You can still explore titles in Discover.',
  emptyShelvesTitle: 'No highlights right now',
  emptyShelves:
    'Browse your full Jellyfin catalog, or request more titles from Discover. New titles appear here once Jellyfin adds them.',
  discover: 'Discover Titles',
  searchLibrary: 'Search library',
  browseAll: 'Browse all titles',
  browseUnwatched: 'Browse unwatched titles',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  partialLibrary: 'Some library shelves could not be refreshed.',
  partialLibraryDescription:
    'You can still open the titles shown below. Try refreshing to check for new additions and progress.',
  shelfNavigation: 'Jump to a library shelf',
  continue: 'Continue Watching',
  recent: 'Recently Added',
  recentEpisodes: 'Recently Added Episodes',
  ready: 'Ready to Watch',
  continueDescription: 'Pick up a paused movie or episode.',
  recentDescription: 'The latest movies and series added to Jellyfin.',
  recentEpisodesDescription: 'New episode files added to Jellyfin.',
  readyDescription: 'Your requested titles that Jellyfin can play.',
  jumpContinue: 'Continue',
  jumpRecent: 'New titles',
  jumpEpisodes: 'New episodes',
  jumpReady: 'Your requests',
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
  const refreshRef = useRef<HTMLButtonElement>(null);

  const {
    data: watchNow,
    error: watchNowError,
    mutate: revalidateWatchNow,
    isValidating,
  } = useSWR<LibraryWatchNowResponse>('/api/v1/library/watch-now', {
    revalidateOnFocus: true,
  });
  useHashNavigation(Boolean(watchNow));
  const shelves = (watchNow?.shelves ?? []).filter(
    (shelf) => shelf.items.length
  );
  const partialLibrary = Boolean(
    shelves.length && (watchNowError || watchNow?.code === 'server_unreachable')
  );
  const refreshShelves = async () => {
    try {
      await revalidateWatchNow();
    } catch {
      // SWR exposes the error while keeping the last available shelves.
    } finally {
      window.requestAnimationFrame(() => {
        if (document.activeElement === document.body)
          refreshRef.current?.focus({ preventScroll: true });
      });
    }
  };
  const shelfCopy: Record<
    LibraryShelf['id'],
    {
      title: string;
      description: string;
      jump: string;
      href?: string;
      endLabel?: string;
    }
  > = {
    continue: {
      title: intl.formatMessage(messages.continue),
      description: intl.formatMessage(messages.continueDescription),
      jump: intl.formatMessage(messages.jumpContinue),
      href: '/library/browse',
      endLabel: intl.formatMessage(messages.browseAll),
    },
    recent: {
      title: intl.formatMessage(messages.recent),
      description: intl.formatMessage(messages.recentDescription),
      jump: intl.formatMessage(messages.jumpRecent),
      href: '/library/browse?sort=dateAdded&order=desc',
    },
    'recent-episodes': {
      title: intl.formatMessage(messages.recentEpisodes),
      description: intl.formatMessage(messages.recentEpisodesDescription),
      jump: intl.formatMessage(messages.jumpEpisodes),
    },
    forgotten: {
      title: intl.formatMessage(messages.ready),
      description: intl.formatMessage(messages.readyDescription),
      jump: intl.formatMessage(messages.jumpReady),
      href: '/library/browse?watched=unwatched',
      endLabel: intl.formatMessage(messages.browseUnwatched),
    },
  };

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
            className="min-h-11"
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
        action: (
          <LinkButton to="/" buttonType="primary" className="min-h-11">
            {intl.formatMessage(messages.discover)}
          </LinkButton>
        ),
      };
    }
    if (
      (watchNow?.code === 'server_unreachable' && !shelves.length) ||
      (watchNowError && !watchNow?.shelves.length)
    ) {
      return {
        icon: ExclamationTriangleIcon,
        title: intl.formatMessage(messages.serverUnreachable),
        description: intl.formatMessage(messages.serverUnreachableDescription),
        action: (
          <Button
            className="min-h-11"
            disabled={isValidating}
            onClick={() => void refreshShelves()}
          >
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
          <div className="flex flex-wrap justify-center gap-2">
            <LinkButton
              to="/library/browse"
              buttonType="primary"
              className="min-h-11"
            >
              {intl.formatMessage(messages.browseAll)}
            </LinkButton>
            <LinkButton to="/" className="min-h-11">
              {intl.formatMessage(messages.discover)}
            </LinkButton>
          </div>
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
      <div className="mb-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
        <Header subtext={intl.formatMessage(messages.subtitle)}>
          {intl.formatMessage(messages.library)}
        </Header>
        {watchNow?.code !== 'unsupported_media_server' && (
          <div className="flex flex-wrap gap-2">
            {watchNow?.code !== 'not_linked' && (
              <LinkButton
                to="/library/browse#library-search"
                className="min-h-11"
              >
                <MagnifyingGlassIcon />
                <span>{intl.formatMessage(messages.searchLibrary)}</span>
              </LinkButton>
            )}
            <Button
              ref={refreshRef}
              className="min-h-11"
              disabled={isValidating}
              onClick={() => void refreshShelves()}
            >
              <ArrowPathIcon
                className={isValidating ? 'animate-spin' : undefined}
              />
              <span>
                {intl.formatMessage(
                  isValidating ? messages.refreshing : messages.refresh
                )}
              </span>
            </Button>
          </div>
        )}
      </div>

      {shelves.length > 1 && (
        <nav
          aria-label={intl.formatMessage(messages.shelfNavigation)}
          className="mb-4 flex flex-wrap gap-2"
        >
          {shelves.map((shelf) => (
            <Link
              key={shelf.id}
              to={`#library-${shelf.id}`}
              className="inline-flex min-h-11 items-center rounded-lg border border-gray-700 bg-gray-800/40 px-3 text-sm text-gray-300 transition hover:bg-gray-700 hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500"
              onClick={() =>
                window.requestAnimationFrame(() =>
                  document
                    .getElementById(`library-${shelf.id}`)
                    ?.focus({ preventScroll: true })
                )
              }
            >
              {shelfCopy[shelf.id].jump}
            </Link>
          ))}
        </nav>
      )}
      {partialLibrary && (
        <Alert
          type="warning"
          title={intl.formatMessage(messages.partialLibrary)}
        >
          {intl.formatMessage(messages.partialLibraryDescription)}
        </Alert>
      )}

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
            {shelves.map((shelf) => (
              <section key={shelf.id} aria-labelledby={`library-${shelf.id}`}>
                <div className="slider-header">
                  <div className="min-w-0">
                    <h2
                      id={`library-${shelf.id}`}
                      tabIndex={-1}
                      className="scroll-mt-24 text-xl font-bold text-gray-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 sm:text-2xl"
                    >
                      {shelfCopy[shelf.id].title}
                    </h2>
                    <p className="mt-1 text-sm leading-6 text-gray-400">
                      {shelfCopy[shelf.id].description}
                    </p>
                  </div>
                </div>
                <Slider
                  sliderKey={`library-${shelf.id}`}
                  ariaLabel={shelfCopy[shelf.id].title}
                  isLoading={false}
                  seeMore={
                    shelfCopy[shelf.id].href
                      ? {
                          url: shelfCopy[shelf.id].href!,
                          posters: shelf.items
                            .slice(-4)
                            .map((item) => item.posterUrl),
                          imageType: 'library',
                          label: shelfCopy[shelf.id].endLabel,
                          layout: shelf.id === 'continue' ? 'resume' : 'poster',
                        }
                      : undefined
                  }
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
              </section>
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
