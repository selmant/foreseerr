import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import LinkButton from '@app/components/Common/LinkButton';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import SlideOver from '@app/components/Common/SlideOver';
import LibraryEpisodeList from '@app/components/Library/LibraryEpisodeList';
import { handleLibraryPlayClick } from '@app/components/Library/libraryPlayAction';
import MediaActionDetailBar from '@app/components/MediaActions/MediaActionDetailBar';
import { useNativeRuntime } from '@app/context/NativeRuntimeContext';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { registerLibraryShelfRevalidator } from '@app/utils/mediaActionInvalidation';
import {
  ArrowPathIcon,
  CogIcon,
  InformationCircleIcon,
} from '@heroicons/react/24/outline';
import { PlayIcon } from '@heroicons/react/24/solid';
import type {
  LibraryItemInspectorResponse,
  LibrarySeasonEpisodesResponse,
  LibraryTitle,
} from '@server/interfaces/api/libraryInterfaces';
import { hasServarrMapping } from '@server/lib/servarrMapping';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Library.LibraryInspector', {
  play: 'Play',
  resume: 'Resume',
  playNext: 'Play Next',
  viewDetails: 'View Details',
  manage: 'Manage downloads',
  retry: 'Retry',
  linkAccount: 'Link Jellyfin account',
  cached:
    'Jellyfin could not refresh this title. Showing the last loaded information.',
  playTitle: '{action}: {title}',
  episodes: 'Episodes',
  watched: 'Watched',
  emptySeason: 'No episodes in this season.',
  loadFailed: 'Could not load episodes. Try again.',
  notFound: 'This title is no longer in your library.',
  notLinked: 'Link your Jellyfin account to inspect library titles.',
  unreachable: 'Could not reach Jellyfin.',
  unsupported: 'Library inspector requires a Jellyfin media server.',
  seasons: 'Season',
  runtime: '{minutes} min',
  progress: '{percent, number}% watched',
  readMore: 'Read more',
  readLess: 'Show less',
});

interface LibraryInspectorProps {
  item: LibraryTitle | null;
  onClose: () => void;
  onManage: (title: MovieDetails | TvDetails) => void;
}

const LibraryInspector = ({
  item,
  onClose,
  onManage,
}: LibraryInspectorProps) => {
  const intl = useIntl();
  const { play } = useNativeRuntime();
  const { hasPermission } = useUser();
  const show = Boolean(item);
  // Keep rendering the last title while the panel slides out.
  const [shownItem, setShownItem] = useState<LibraryTitle | null>(item);
  const [selectedSeasonId, setSelectedSeasonId] = useState<string | null>(null);
  const [overviewExpanded, setOverviewExpanded] = useState(false);

  useEffect(() => setOverviewExpanded(false), [item?.jellyfinItemId]);

  useEffect(() => {
    if (item) {
      setShownItem(item);
    }
  }, [item]);

  const current = item ?? shownItem;
  const inspectorId =
    current?.inspectorItemId ??
    current?.jellyfinSeriesId ??
    current?.jellyfinItemId;
  const inspectorKey = inspectorId
    ? `/api/v1/library/items/${inspectorId}`
    : '';

  const {
    data,
    error,
    mutate: mutateInspector,
    isValidating: refreshingInspector,
  } = useSWR<LibraryItemInspectorResponse>(inspectorKey || null);

  const seriesId =
    data?.mediaType === 'tv'
      ? (data.jellyfinSeriesId ?? data.jellyfinItemId)
      : undefined;

  useEffect(() => {
    const seasons = data?.seasons;
    if (!seasons?.length) {
      setSelectedSeasonId(null);
      return;
    }
    setSelectedSeasonId((selected) => {
      if (selected && seasons.some((s) => s.jellyfinSeasonId === selected)) {
        return selected;
      }
      const preferred =
        seasons.find((s) => (s.indexNumber ?? 0) >= 1) ?? seasons[0];
      return preferred.jellyfinSeasonId;
    });
  }, [data]);

  const episodesKey =
    seriesId && selectedSeasonId
      ? `/api/v1/library/series/${seriesId}/seasons/${selectedSeasonId}/episodes`
      : '';

  const {
    data: episodes,
    error: episodesError,
    mutate: mutateEpisodes,
    isValidating: refreshingEpisodes,
  } = useSWR<LibrarySeasonEpisodesResponse>(episodesKey || null);

  useEffect(() => {
    if (!show || !inspectorKey) {
      return undefined;
    }
    return registerLibraryShelfRevalidator(async () => {
      await Promise.all([
        mutateInspector(),
        episodesKey ? mutateEpisodes() : Promise.resolve(),
      ]);
    });
  }, [episodesKey, inspectorKey, mutateEpisodes, mutateInspector, show]);

  const mediaType = data?.mediaType ?? current?.mediaType;
  const tmdbId = data?.tmdbId ?? current?.tmdbId;
  const { data: managedTitle } = useSWR<MovieDetails | TvDetails>(
    tmdbId && mediaType && hasPermission(Permission.MANAGE_REQUESTS)
      ? `/api/v1/${mediaType}/${tmdbId}`
      : null
  );
  const canManage = hasServarrMapping(
    managedTitle && 'mediaInfo' in managedTitle
      ? managedTitle.mediaInfo
      : undefined
  );

  const playTarget = (
    event: React.MouseEvent<HTMLAnchorElement | HTMLButtonElement>,
    itemId: string,
    label: string,
    fallbackUrl: string
  ) => {
    handleLibraryPlayClick(event, play, {
      provider: 'jellyfin',
      itemId,
      fallbackUrl,
      label,
      quality: 'standard',
    });
  };

  const title = data?.title || current?.title || '';
  const progress = data?.progressPercent ?? current?.progressPercent ?? 0;
  const detailsHref = tmdbId
    ? `/${mediaType === 'movie' ? 'movie' : 'tv'}/${tmdbId}`
    : undefined;
  const artwork =
    data?.backdropUrl ||
    data?.posterUrl ||
    current?.backdropUrl ||
    current?.posterUrl;
  const meta = data
    ? [
        data.year,
        data.runtimeMinutes
          ? intl.formatMessage(messages.runtime, {
              minutes: data.runtimeMinutes,
            })
          : null,
        ...(data.genres ?? []).slice(0, 3),
      ]
        .filter(Boolean)
        .join(' · ')
    : undefined;
  const inspectorErrorStatus = (
    error as { response?: { status?: number } } | undefined
  )?.response?.status;
  const inspectorNotFound =
    data?.code === 'not_found' || inspectorErrorStatus === 404;
  const selectedSeason = data?.seasons?.find(
    (season) => season.jellyfinSeasonId === selectedSeasonId
  );
  const retry = (scope: 'title' | 'episodes') => {
    const refreshing =
      scope === 'title' ? refreshingInspector : refreshingEpisodes;
    const revalidate = scope === 'title' ? mutateInspector : mutateEpisodes;
    return (
      <Button
        type="button"
        className="mt-3 min-h-11"
        aria-disabled={refreshing}
        aria-busy={refreshing}
        onClick={() => {
          if (!refreshing) void revalidate().catch(() => undefined);
        }}
      >
        <ArrowPathIcon
          aria-hidden
          className={
            refreshing ? 'animate-spin motion-reduce:animate-none' : ''
          }
        />
        <span>{intl.formatMessage(messages.retry)}</span>
      </Button>
    );
  };
  const playAction = intl.formatMessage(
    progress > 0 && progress < 100
      ? messages.resume
      : mediaType === 'tv'
        ? messages.playNext
        : messages.play
  );
  const canPlay = Boolean(
    data?.playItemId &&
    (data.playUrl || data.mediaUrl) &&
    !data.code &&
    !inspectorNotFound
  );
  const footer =
    canPlay || detailsHref || (canManage && managedTitle) ? (
      <div className="space-y-3">
        {canPlay && data?.subtitle ? (
          <p className="text-sm font-medium text-gray-300">{data.subtitle}</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {canPlay && data ? (
            <Button
              as="a"
              href={data.playUrl ?? data.mediaUrl}
              buttonType="primary"
              className="min-h-11 w-full justify-center sm:w-auto"
              aria-label={intl.formatMessage(messages.playTitle, {
                action: playAction,
                title: [title, data.subtitle].filter(Boolean).join(' · '),
              })}
              onClick={(event) =>
                playTarget(
                  event,
                  data.playItemId as string,
                  data.subtitle || title,
                  (data.playUrl ?? data.mediaUrl) as string
                )
              }
            >
              <PlayIcon />
              <span>{playAction}</span>
            </Button>
          ) : null}
          {detailsHref ? (
            <LinkButton
              to={detailsHref}
              className="min-h-11 w-full justify-center sm:w-auto"
            >
              <InformationCircleIcon />
              <span>{intl.formatMessage(messages.viewDetails)}</span>
            </LinkButton>
          ) : null}
          {canManage && managedTitle ? (
            <Button
              className="min-h-11 w-full justify-center sm:w-auto"
              onClick={() => onManage(managedTitle)}
            >
              <CogIcon />
              <span>{intl.formatMessage(messages.manage)}</span>
            </Button>
          ) : null}
        </div>
      </div>
    ) : undefined;

  const renderBody = () => {
    if (data?.code === 'not_linked') {
      return (
        <Alert type="info" title={intl.formatMessage(messages.notLinked)}>
          <LinkButton
            to="/profile/settings/linked-accounts"
            className="mt-3 min-h-11"
          >
            {intl.formatMessage(messages.linkAccount)}
          </LinkButton>
        </Alert>
      );
    }
    if (data?.code === 'unsupported_media_server') {
      return (
        <Alert type="info" title={intl.formatMessage(messages.unsupported)} />
      );
    }
    if (inspectorNotFound) {
      return (
        <Alert type="warning" title={intl.formatMessage(messages.notFound)} />
      );
    }
    if ((error && !data) || data?.code === 'server_unreachable') {
      return (
        <Alert type="error" title={intl.formatMessage(messages.unreachable)}>
          {retry('title')}
        </Alert>
      );
    }
    if (!data) {
      return <LoadingSpinner />;
    }

    return (
      <div className="space-y-6">
        {error ? (
          <Alert type="warning" title={intl.formatMessage(messages.cached)}>
            {retry('title')}
          </Alert>
        ) : null}
        {artwork ? (
          <div className="relative aspect-video overflow-hidden rounded-lg bg-gray-700 shadow ring-1 ring-gray-700">
            <CachedImage
              type="library"
              src={artwork}
              alt=""
              fill
              className="object-cover"
              sizes="448px"
            />
            {progress > 0 ? (
              <div className="absolute inset-x-0 bottom-0 h-1 bg-black/70">
                <div
                  className="h-full bg-indigo-500"
                  style={{ width: `${Math.min(100, progress)}%` }}
                />
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-3">
          {progress > 0 && progress < 100 ? (
            <p className="text-sm text-indigo-300">
              {intl.formatMessage(messages.progress, {
                percent: Math.round(progress),
              })}
            </p>
          ) : null}
          {tmdbId ? (
            <MediaActionDetailBar
              title={title}
              tmdbId={tmdbId}
              mediaType={data.mediaType}
              showLabels
            />
          ) : null}
        </div>

        {data.overview ? (
          <div>
            <p
              className={`text-sm leading-6 text-gray-300 ${data.overview.length > 300 && !overviewExpanded ? 'line-clamp-4' : ''}`}
            >
              {data.overview}
            </p>
            {data.overview.length > 300 ? (
              <button
                type="button"
                aria-expanded={overviewExpanded}
                onClick={() => setOverviewExpanded((value) => !value)}
                className="mt-1 min-h-11 rounded px-1 text-sm text-indigo-300 hover:text-indigo-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                {intl.formatMessage(
                  overviewExpanded ? messages.readLess : messages.readMore
                )}
              </button>
            ) : null}
          </div>
        ) : null}

        {data.mediaType === 'tv' && data.seasons?.length ? (
          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold">
                {intl.formatMessage(messages.episodes)}
              </h3>
              {data.seasons.length > 1 ? (
                <select
                  aria-label={intl.formatMessage(messages.seasons)}
                  className="min-h-11 w-auto max-w-[60%] flex-none"
                  value={selectedSeasonId ?? ''}
                  onChange={(event) => setSelectedSeasonId(event.target.value)}
                >
                  {data.seasons.map((season) => (
                    <option
                      key={season.jellyfinSeasonId}
                      value={season.jellyfinSeasonId}
                    >
                      {season.name}
                    </option>
                  ))}
                </select>
              ) : selectedSeason ? (
                <span className="text-sm text-gray-400">
                  {selectedSeason.name}
                </span>
              ) : null}
            </div>
            {episodesError || episodes?.code ? (
              <Alert
                type="warning"
                title={intl.formatMessage(
                  episodes?.code === 'not_linked'
                    ? messages.notLinked
                    : messages.loadFailed
                )}
              >
                {episodes?.code === 'not_linked' ? (
                  <LinkButton
                    to="/profile/settings/linked-accounts"
                    className="mt-3 min-h-11"
                  >
                    {intl.formatMessage(messages.linkAccount)}
                  </LinkButton>
                ) : (
                  retry('episodes')
                )}
              </Alert>
            ) : null}
            {!episodes && !episodesError ? (
              <LoadingSpinner />
            ) : !episodes || episodes.code ? null : !episodes.episodes
                .length ? (
              <p className="text-sm text-gray-400">
                {intl.formatMessage(messages.emptySeason)}
              </p>
            ) : (
              <LibraryEpisodeList
                key={episodesKey}
                episodes={episodes.episodes}
                episodesKey={episodesKey}
                tmdbId={tmdbId}
                playItemId={data.playItemId}
                onPlay={(event, episode) =>
                  playTarget(
                    event,
                    episode.jellyfinItemId,
                    `${title} ${episode.subtitle ?? episode.name}`,
                    episode.mediaUrl as string
                  )
                }
              />
            )}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <SlideOver
      show={show}
      title={title}
      subText={meta}
      onClose={onClose}
      footer={footer}
    >
      {current ? renderBody() : null}
    </SlideOver>
  );
};

export default LibraryInspector;
