import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import LibraryEpisodeWatchToggle from '@app/components/Library/LibraryEpisodeWatchToggle';
import { handleLibraryPlayClick } from '@app/components/Library/libraryPlayAction';
import MediaActionDetailBar from '@app/components/MediaActions/MediaActionDetailBar';
import TvFocusable from '@app/components/Tv/TvFocusable';
import { useNativeRuntime } from '@app/context/NativeRuntimeContext';
import { useLockBodyScroll } from '@app/hooks/useLockBodyScroll';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { registerLibraryShelfRevalidator } from '@app/utils/mediaActionInvalidation';
import { XMarkIcon } from '@heroicons/react/24/outline';
import type {
  LibraryEpisode,
  LibraryItemInspectorResponse,
  LibrarySeasonEpisodesResponse,
  LibraryTitle,
} from '@server/interfaces/api/libraryInterfaces';
import { hasServarrMapping } from '@server/lib/servarrMapping';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import { Fragment, useEffect, useRef, useState } from 'react';
import ReactDOM from 'react-dom';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Library.LibraryInspector', {
  play: 'Play',
  resume: 'Resume',
  playNext: 'Play next',
  viewDetails: 'View full details',
  manage: 'Manage',
  close: 'Close inspector',
  episodes: 'Episodes',
  watched: 'Watched',
  closeEpisode: 'Close',
  emptySeason: 'No episodes in this season.',
  loadFailed: 'Could not load this title. Try again.',
  notFound: 'This title is no longer in your library.',
  notLinked: 'Link your Jellyfin account to inspect library titles.',
  unreachable: 'Could not reach Jellyfin.',
  unsupported: 'Library inspector requires a Jellyfin media server.',
  seasons: 'Season',
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
  const { play, isTvShell } = useNativeRuntime();
  const { hasPermission } = useUser();
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);
  const [selectedSeasonId, setSelectedSeasonId] = useState<string | null>(null);
  const [selectedEpisode, setSelectedEpisode] = useState<LibraryEpisode | null>(
    null
  );
  const [episodeWatchOverrides, setEpisodeWatchOverrides] = useState<
    Map<string, boolean>
  >(new Map());
  const show = Boolean(item);
  useLockBodyScroll(show);

  const inspectorId =
    item?.inspectorItemId ?? item?.jellyfinSeriesId ?? item?.jellyfinItemId;

  const {
    data,
    error,
    mutate: mutateInspector,
  } = useSWR<LibraryItemInspectorResponse>(
    show && inspectorId ? `/api/v1/library/items/${inspectorId}` : null
  );

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
    setSelectedSeasonId((current) => {
      if (current && seasons.some((s) => s.jellyfinSeasonId === current)) {
        return current;
      }
      const preferred =
        seasons.find((s) => (s.indexNumber ?? 0) >= 1) ?? seasons[0];
      return preferred.jellyfinSeasonId;
    });
  }, [data]);

  const {
    data: episodes,
    error: episodesError,
    mutate: mutateEpisodes,
  } = useSWR<LibrarySeasonEpisodesResponse>(
    show && seriesId && selectedSeasonId
      ? `/api/v1/library/series/${seriesId}/seasons/${selectedSeasonId}/episodes`
      : null
  );

  const episodesKey =
    show && seriesId && selectedSeasonId
      ? `/api/v1/library/series/${seriesId}/seasons/${selectedSeasonId}/episodes`
      : '';

  const inspectorKey =
    show && inspectorId ? `/api/v1/library/items/${inspectorId}` : '';

  useEffect(() => {
    if (!inspectorKey) {
      return undefined;
    }
    return registerLibraryShelfRevalidator(async () => {
      await Promise.all([
        mutateInspector(),
        episodesKey ? mutateEpisodes() : Promise.resolve(),
      ]);
    });
  }, [episodesKey, inspectorKey, mutateEpisodes, mutateInspector]);

  useEffect(() => {
    setEpisodeWatchOverrides(new Map());
    setSelectedEpisode(null);
  }, [selectedSeasonId]);

  useEffect(() => {
    if (show) {
      openerRef.current = document.activeElement;
      window.setTimeout(() => panelRef.current?.focus(), 0);
    } else if (openerRef.current instanceof HTMLElement) {
      openerRef.current.focus();
    }
  }, [show]);

  const tmdbId = data?.tmdbId ?? item?.tmdbId;
  const { data: managedTitle } = useSWR<MovieDetails | TvDetails>(
    show && tmdbId && hasPermission(Permission.MANAGE_REQUESTS)
      ? `/api/v1/${data?.mediaType ?? item?.mediaType}/${tmdbId}`
      : null
  );
  const canManage = hasServarrMapping(
    managedTitle && 'mediaInfo' in managedTitle
      ? managedTitle.mediaInfo
      : undefined
  );

  const playTarget = (
    event: { preventDefault: () => void },
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

  if (typeof document === 'undefined') {
    return null;
  }

  const title = data?.title || item?.title || '';
  const progress = data?.progressPercent ?? item?.progressPercent ?? 0;
  const detailsHref =
    tmdbId && (data?.mediaType ?? item?.mediaType) === 'movie'
      ? `/movie/${tmdbId}`
      : tmdbId
        ? `/tv/${tmdbId}`
        : undefined;
  const artwork = data?.backdropUrl || data?.posterUrl || item?.backdropUrl;
  const inspectorErrorStatus = (
    error as { response?: { status?: number } } | undefined
  )?.response?.status;
  const inspectorNotFound =
    data?.code === 'not_found' || inspectorErrorStatus === 404;

  return ReactDOM.createPortal(
    <Fragment>
      {show ? (
        /* eslint-disable jsx-a11y/no-static-element-interactions */
        <div
          className="library-motion fixed inset-0 z-50 bg-black/60"
          onClick={onClose}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              onClose();
            }
          }}
        >
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={title}
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                onClose();
                return;
              }
              if (event.key !== 'Tab') {
                return;
              }

              const focusable = Array.from(
                panelRef.current?.querySelectorAll<HTMLElement>(
                  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
                ) ?? []
              );
              if (!focusable.length) {
                event.preventDefault();
                panelRef.current?.focus();
                return;
              }

              const first = focusable[0];
              const last = focusable[focusable.length - 1];
              if (document.activeElement === panelRef.current) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
              } else if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }}
            className="library-sheet library-motion absolute inset-x-0 bottom-0 flex max-h-[92vh] flex-col overflow-hidden rounded-t-2xl bg-library-navy ring-1 ring-gray-700 sm:inset-y-0 sm:left-auto sm:right-0 sm:h-full sm:max-h-none sm:w-[32rem] sm:rounded-none"
          >
            <div className="relative h-40 shrink-0 bg-library-charcoal sm:h-52">
              {artwork ? (
                <CachedImage
                  type="library"
                  src={artwork}
                  alt=""
                  fill
                  className="object-cover opacity-60"
                  sizes="512px"
                />
              ) : null}
              <TvFocusable>
                <button
                  type="button"
                  className="absolute right-3 top-3 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md bg-black/50 text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400"
                  aria-label={intl.formatMessage(messages.close)}
                  onClick={onClose}
                >
                  <XMarkIcon className="h-6 w-6" />
                </button>
              </TvFocusable>
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              {data?.code === 'not_linked' ? (
                <p className="text-sm text-gray-300">
                  {intl.formatMessage(messages.notLinked)}
                </p>
              ) : data?.code === 'unsupported_media_server' ? (
                <p className="text-sm text-gray-300">
                  {intl.formatMessage(messages.unsupported)}
                </p>
              ) : inspectorNotFound ? (
                <p
                  className="text-sm text-red-400"
                  role="alert"
                  aria-live="polite"
                >
                  {intl.formatMessage(messages.notFound)}
                </p>
              ) : error || data?.code === 'server_unreachable' ? (
                <p
                  className="text-sm text-red-400"
                  role="alert"
                  aria-live="polite"
                >
                  {intl.formatMessage(messages.unreachable)}
                </p>
              ) : !data ? (
                <LoadingSpinner />
              ) : (
                <div className="space-y-4">
                  <div>
                    <h2 className="library-display text-3xl font-semibold uppercase text-white">
                      {title}
                    </h2>
                    <p className="mt-1 text-sm text-gray-400">
                      {[
                        data.year,
                        data.runtimeMinutes
                          ? `${data.runtimeMinutes} min`
                          : null,
                        ...(data.genres ?? []),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </div>
                  {data.overview ? (
                    <p className="text-sm leading-6 text-gray-300">
                      {data.overview}
                    </p>
                  ) : null}
                  {progress > 0 ? (
                    <div className="h-1 overflow-hidden rounded bg-gray-800">
                      <div
                        className="h-full bg-indigo-500"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    {data.playItemId && (data.playUrl || data.mediaUrl) ? (
                      <TvFocusable>
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
                          {intl.formatMessage(
                            data.mediaType === 'tv'
                              ? messages.playNext
                              : progress > 0
                                ? messages.resume
                                : messages.play
                          )}
                        </Button>
                      </TvFocusable>
                    ) : null}
                    {tmdbId && !isTvShell ? (
                      <MediaActionDetailBar
                        tmdbId={tmdbId}
                        mediaType={data.mediaType}
                      />
                    ) : null}
                    {detailsHref ? (
                      <TvFocusable>
                        <Button as="a" href={detailsHref} buttonType="default">
                          {intl.formatMessage(messages.viewDetails)}
                        </Button>
                      </TvFocusable>
                    ) : null}
                    {!isTvShell && canManage && managedTitle ? (
                      <Button
                        buttonType="default"
                        onClick={() => onManage(managedTitle)}
                      >
                        {intl.formatMessage(messages.manage)}
                      </Button>
                    ) : null}
                  </div>

                  {data.mediaType === 'tv' && data.seasons?.length ? (
                    <div className="space-y-3">
                      <label className="block text-sm text-gray-400 sm:hidden">
                        {intl.formatMessage(messages.seasons)}
                        <select
                          className="mt-1 min-h-11 w-full rounded-md border border-gray-700 bg-gray-900 px-3 text-gray-100"
                          value={selectedSeasonId ?? ''}
                          onChange={(event) =>
                            setSelectedSeasonId(event.target.value)
                          }
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
                      </label>
                      <div
                        role="tablist"
                        className="hidden flex-wrap gap-2 sm:flex"
                      >
                        {data.seasons.map((season) => (
                          <TvFocusable
                            key={season.jellyfinSeasonId}
                            onEnterPress={() =>
                              setSelectedSeasonId(season.jellyfinSeasonId)
                            }
                          >
                            <button
                              type="button"
                              role="tab"
                              aria-selected={
                                selectedSeasonId === season.jellyfinSeasonId
                              }
                              className={`min-h-11 rounded-md px-3 text-sm ${
                                selectedSeasonId === season.jellyfinSeasonId
                                  ? 'bg-indigo-600 text-white'
                                  : 'bg-gray-800 text-gray-300'
                              }`}
                              onClick={() =>
                                setSelectedSeasonId(season.jellyfinSeasonId)
                              }
                            >
                              {season.name}
                            </button>
                          </TvFocusable>
                        ))}
                      </div>
                      <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-400">
                        {intl.formatMessage(messages.episodes)}
                      </h3>
                      {!episodes && !episodesError ? (
                        <LoadingSpinner />
                      ) : episodesError ? (
                        <p className="text-sm text-red-400" role="alert">
                          {intl.formatMessage(messages.loadFailed)}
                        </p>
                      ) : !episodes?.episodes.length ? (
                        <p className="text-sm text-gray-400">
                          {intl.formatMessage(messages.emptySeason)}
                        </p>
                      ) : (
                        <ul className="divide-y divide-gray-800 rounded-md ring-1 ring-gray-800">
                          {episodes.episodes.map((episode) => {
                            const watched =
                              episodeWatchOverrides.get(
                                episode.jellyfinItemId
                              ) ?? Boolean(episode.watched);
                            const selected =
                              selectedEpisode?.jellyfinItemId ===
                              episode.jellyfinItemId;
                            const row = (
                              <li
                                key={episode.jellyfinItemId}
                                className={`flex min-h-11 items-center gap-3 px-3 py-2 ${
                                  selected ? 'bg-gray-800/80' : ''
                                }`}
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-sm text-gray-100">
                                    {episode.subtitle
                                      ? `${episode.subtitle} · `
                                      : ''}
                                    {episode.name}
                                  </div>
                                  {watched ? (
                                    <div className="text-xs text-gray-500">
                                      {intl.formatMessage(messages.watched)}
                                    </div>
                                  ) : episode.progressPercent ? (
                                    <div className="mt-1 h-1 overflow-hidden rounded bg-gray-800">
                                      <div
                                        className="h-full bg-indigo-500"
                                        style={{
                                          width: `${episode.progressPercent}%`,
                                        }}
                                      />
                                    </div>
                                  ) : null}
                                </div>
                                {!isTvShell &&
                                tmdbId &&
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
                                      setEpisodeWatchOverrides((current) => {
                                        const next = new Map(current);
                                        next.set(
                                          episode.jellyfinItemId,
                                          nextWatched
                                        );
                                        return next;
                                      })
                                    }
                                  />
                                ) : null}
                                {!isTvShell && episode.mediaUrl ? (
                                  <Button
                                    as="a"
                                    href={episode.mediaUrl}
                                    buttonType="primary"
                                    buttonSize="sm"
                                    onClick={(event) =>
                                      playTarget(
                                        event,
                                        episode.jellyfinItemId,
                                        `${title} ${
                                          episode.subtitle ?? episode.name
                                        }`,
                                        episode.mediaUrl as string
                                      )
                                    }
                                  >
                                    {intl.formatMessage(messages.play)}
                                  </Button>
                                ) : null}
                              </li>
                            );
                            if (!isTvShell) {
                              return row;
                            }
                            return (
                              <TvFocusable
                                key={episode.jellyfinItemId}
                                onEnterPress={() => setSelectedEpisode(episode)}
                              >
                                {row}
                              </TvFocusable>
                            );
                          })}
                        </ul>
                      )}
                      {isTvShell && selectedEpisode ? (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          {selectedEpisode.mediaUrl ? (
                            <TvFocusable
                              onEnterPress={() =>
                                playTarget(
                                  { preventDefault: () => undefined },
                                  selectedEpisode.jellyfinItemId,
                                  `${title} ${
                                    selectedEpisode.subtitle ??
                                    selectedEpisode.name
                                  }`,
                                  selectedEpisode.mediaUrl as string
                                )
                              }
                            >
                              <Button
                                as="a"
                                href={selectedEpisode.mediaUrl}
                                buttonType="primary"
                                onClick={(event) =>
                                  playTarget(
                                    event,
                                    selectedEpisode.jellyfinItemId,
                                    `${title} ${
                                      selectedEpisode.subtitle ??
                                      selectedEpisode.name
                                    }`,
                                    selectedEpisode.mediaUrl as string
                                  )
                                }
                              >
                                {intl.formatMessage(messages.play)}
                              </Button>
                            </TvFocusable>
                          ) : null}
                          {tmdbId &&
                          selectedEpisode.parentIndexNumber != null &&
                          selectedEpisode.indexNumber != null ? (
                            <TvFocusable>
                              <LibraryEpisodeWatchToggle
                                tmdbId={tmdbId}
                                jellyfinItemId={selectedEpisode.jellyfinItemId}
                                seasonNumber={selectedEpisode.parentIndexNumber}
                                episodeNumber={selectedEpisode.indexNumber}
                                watched={
                                  episodeWatchOverrides.get(
                                    selectedEpisode.jellyfinItemId
                                  ) ?? Boolean(selectedEpisode.watched)
                                }
                                episodesKey={episodesKey}
                                showLabel
                                onLocalChange={(nextWatched) =>
                                  setEpisodeWatchOverrides((current) => {
                                    const next = new Map(current);
                                    next.set(
                                      selectedEpisode.jellyfinItemId,
                                      nextWatched
                                    );
                                    return next;
                                  })
                                }
                              />
                            </TvFocusable>
                          ) : null}
                          <TvFocusable
                            onEnterPress={() => setSelectedEpisode(null)}
                          >
                            <Button
                              buttonType="default"
                              onClick={() => setSelectedEpisode(null)}
                            >
                              {intl.formatMessage(messages.closeEpisode)}
                            </Button>
                          </TvFocusable>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </Fragment>,
    document.body
  );
};

export default LibraryInspector;
