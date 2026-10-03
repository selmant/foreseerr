import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import LinkButton from '@app/components/Common/LinkButton';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import SlideOver from '@app/components/Common/SlideOver';
import LibraryEpisodeWatchToggle from '@app/components/Library/LibraryEpisodeWatchToggle';
import { handleLibraryPlayClick } from '@app/components/Library/libraryPlayAction';
import MediaActionDetailBar from '@app/components/MediaActions/MediaActionDetailBar';
import { useNativeRuntime } from '@app/context/NativeRuntimeContext';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { registerLibraryShelfRevalidator } from '@app/utils/mediaActionInvalidation';
import { CogIcon, InformationCircleIcon } from '@heroicons/react/24/outline';
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
  manage: 'Manage',
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
  const [episodeWatchOverrides, setEpisodeWatchOverrides] = useState<
    Map<string, boolean>
  >(new Map());

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

  useEffect(() => {
    setEpisodeWatchOverrides(new Map());
  }, [selectedSeasonId]);

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

  const renderBody = () => {
    if (data?.code === 'not_linked') {
      return (
        <Alert type="info" title={intl.formatMessage(messages.notLinked)} />
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
    if (error || data?.code === 'server_unreachable') {
      return (
        <Alert type="error" title={intl.formatMessage(messages.unreachable)} />
      );
    }
    if (!data) {
      return <LoadingSpinner />;
    }

    return (
      <div className="space-y-6">
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
          {data.subtitle && data.mediaType === 'tv' ? (
            <p className="text-sm font-medium text-gray-300">{data.subtitle}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {data.playItemId && (data.playUrl || data.mediaUrl) ? (
              <Button
                as="a"
                href={data.playUrl ?? data.mediaUrl}
                buttonType="primary"
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
                <span>
                  {intl.formatMessage(
                    data.mediaType === 'tv'
                      ? messages.playNext
                      : progress > 0
                        ? messages.resume
                        : messages.play
                  )}
                </span>
              </Button>
            ) : null}
            {detailsHref ? (
              <LinkButton to={detailsHref} buttonType="default">
                <InformationCircleIcon />
                <span>{intl.formatMessage(messages.viewDetails)}</span>
              </LinkButton>
            ) : null}
            {canManage && managedTitle ? (
              <Button
                buttonType="default"
                onClick={() => onManage(managedTitle)}
              >
                <CogIcon />
                <span>{intl.formatMessage(messages.manage)}</span>
              </Button>
            ) : null}
          </div>
          {tmdbId ? (
            <MediaActionDetailBar tmdbId={tmdbId} mediaType={data.mediaType} />
          ) : null}
        </div>

        {data.overview ? (
          <p className="text-sm leading-6 text-gray-300">{data.overview}</p>
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
                  className="w-auto max-w-[60%] flex-none"
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
            {!episodes && !episodesError ? (
              <LoadingSpinner />
            ) : episodesError ? (
              <Alert
                type="error"
                title={intl.formatMessage(messages.loadFailed)}
              />
            ) : !episodes?.episodes.length ? (
              <p className="text-sm text-gray-400">
                {intl.formatMessage(messages.emptySeason)}
              </p>
            ) : (
              <ul className="divide-y divide-gray-700 overflow-hidden rounded-lg border border-gray-700">
                {episodes.episodes.map((episode) => {
                  const watched =
                    episodeWatchOverrides.get(episode.jellyfinItemId) ??
                    Boolean(episode.watched);
                  return (
                    <li
                      key={episode.jellyfinItemId}
                      className="flex items-center gap-2 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-white">
                          {episode.name}
                        </div>
                        {episode.subtitle || watched ? (
                          <div className="truncate text-xs text-gray-400">
                            {[
                              episode.subtitle,
                              watched
                                ? intl.formatMessage(messages.watched)
                                : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                        ) : null}
                        {!watched && episode.progressPercent ? (
                          <div className="mt-1 h-1 overflow-hidden rounded bg-gray-700">
                            <div
                              className="h-full bg-indigo-500"
                              style={{
                                width: `${Math.min(100, episode.progressPercent)}%`,
                              }}
                            />
                          </div>
                        ) : null}
                      </div>
                      {tmdbId &&
                      episode.parentIndexNumber != null &&
                      episode.indexNumber != null ? (
                        <LibraryEpisodeWatchToggle
                          tmdbId={tmdbId}
                          jellyfinItemId={episode.jellyfinItemId}
                          seasonNumber={episode.parentIndexNumber}
                          episodeNumber={episode.indexNumber}
                          watched={watched}
                          episodesKey={episodesKey}
                          onLocalChange={(nextWatched) =>
                            setEpisodeWatchOverrides((overrides) => {
                              const next = new Map(overrides);
                              next.set(episode.jellyfinItemId, nextWatched);
                              return next;
                            })
                          }
                        />
                      ) : null}
                      {episode.mediaUrl ? (
                        <Button
                          as="a"
                          href={episode.mediaUrl}
                          buttonType="primary"
                          buttonSize="sm"
                          aria-label={`${intl.formatMessage(messages.play)} ${
                            episode.subtitle ?? episode.name
                          }`}
                          onClick={(event) =>
                            playTarget(
                              event,
                              episode.jellyfinItemId,
                              `${title} ${episode.subtitle ?? episode.name}`,
                              episode.mediaUrl as string
                            )
                          }
                        >
                          <PlayIcon />
                          <span>{intl.formatMessage(messages.play)}</span>
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <SlideOver show={show} title={title} subText={meta} onClose={onClose}>
      {current ? renderBody() : null}
    </SlideOver>
  );
};

export default LibraryInspector;
