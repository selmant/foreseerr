import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import SlideOver from '@app/components/Common/SlideOver';
import LibraryEpisodeWatchToggle from '@app/components/Library/LibraryEpisodeWatchToggle';
import { handleLibraryPlayClick } from '@app/components/Library/libraryPlayAction';
import { useNativeRuntime } from '@app/context/NativeRuntimeContext';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { registerLibraryShelfRevalidator } from '@app/utils/mediaActionInvalidation';
import type {
  LibrarySeasonEpisodesResponse,
  LibrarySeriesDetailResponse,
} from '@server/interfaces/api/libraryInterfaces';
import { hasServarrMapping } from '@server/lib/servarrMapping';
import type { TvDetails } from '@server/models/Tv';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Library.LibrarySeriesPanel', {
  playNext: 'Play next',
  viewDetails: 'View details',
  episodes: 'Episodes',
  manageInSonarr: 'Manage in Sonarr',
  watched: 'Watched',
  play: 'Play',
  emptySeason: 'No episodes in this season.',
  loadFailed: 'Could not load seasons. Try again.',
  notLinked: 'Link your Jellyfin account to browse episodes.',
  unreachable: 'Could not reach Jellyfin.',
});

interface LibrarySeriesPanelProps {
  show: boolean;
  jellyfinSeriesId: string | null;
  seedTitle?: string;
  seedTmdbId?: number;
  seedPlayItemId?: string;
  seedSubtitle?: string;
  onManage?: (title: TvDetails) => void;
  onClose: () => void;
}

const LibrarySeriesPanel = ({
  show,
  jellyfinSeriesId,
  seedTitle,
  seedTmdbId,
  seedPlayItemId,
  seedSubtitle,
  onManage,
  onClose,
}: LibrarySeriesPanelProps) => {
  const intl = useIntl();
  const { play } = useNativeRuntime();
  const { hasPermission } = useUser();
  const [selectedSeasonId, setSelectedSeasonId] = useState<string | null>(null);
  const [episodeWatchOverrides, setEpisodeWatchOverrides] = useState<
    Map<string, boolean>
  >(new Map());

  const { data: series, error: seriesError } =
    useSWR<LibrarySeriesDetailResponse>(
      show && jellyfinSeriesId
        ? `/api/v1/library/series/${jellyfinSeriesId}`
        : null
    );

  useEffect(() => {
    if (!series?.seasons?.length) {
      setSelectedSeasonId(null);
      return;
    }
    setSelectedSeasonId((current) => {
      if (
        current &&
        series.seasons.some((s) => s.jellyfinSeasonId === current)
      ) {
        return current;
      }
      const preferred =
        series.seasons.find((s) => (s.indexNumber ?? 0) >= 1) ??
        series.seasons[0];
      return preferred.jellyfinSeasonId;
    });
  }, [series]);

  useEffect(() => {
    setEpisodeWatchOverrides(new Map());
  }, [selectedSeasonId]);

  const {
    data: episodes,
    error: episodesError,
    mutate: mutateEpisodes,
  } = useSWR<LibrarySeasonEpisodesResponse>(
    show && jellyfinSeriesId && selectedSeasonId
      ? `/api/v1/library/series/${jellyfinSeriesId}/seasons/${selectedSeasonId}/episodes`
      : null
  );

  const episodesKey =
    show && jellyfinSeriesId && selectedSeasonId
      ? `/api/v1/library/series/${jellyfinSeriesId}/seasons/${selectedSeasonId}/episodes`
      : '';

  useEffect(() => {
    if (!episodesKey) {
      return undefined;
    }
    return registerLibraryShelfRevalidator(async () => {
      await mutateEpisodes();
    });
  }, [episodesKey, mutateEpisodes]);

  const title = series?.title || seedTitle || 'Series';
  const tmdbId = series?.tmdbId ?? seedTmdbId;
  const playItemId = series?.playItemId || seedPlayItemId;
  const playSubtitle = series?.subtitle || seedSubtitle;
  const statusCode = series?.code ?? episodes?.code;
  const { data: managedTitle } = useSWR<TvDetails>(
    show && tmdbId && hasPermission(Permission.MANAGE_REQUESTS)
      ? `/api/v1/tv/${tmdbId}`
      : null
  );
  const canManage = hasServarrMapping(managedTitle?.mediaInfo);

  const playEpisode = (
    event: React.MouseEvent<HTMLAnchorElement>,
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

  return (
    <SlideOver show={show} title={title} onClose={onClose}>
      {statusCode === 'not_linked' ? (
        <p className="text-sm text-gray-300">
          {intl.formatMessage(messages.notLinked)}
        </p>
      ) : statusCode === 'server_unreachable' || seriesError ? (
        <p className="text-sm text-red-400">
          {intl.formatMessage(messages.unreachable)}
        </p>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {playItemId && series?.playUrl ? (
              <Button
                as="a"
                href={series.playUrl}
                buttonType="primary"
                onClick={(event) =>
                  playEpisode(
                    event,
                    playItemId,
                    playSubtitle || title,
                    series.playUrl!
                  )
                }
              >
                {intl.formatMessage(messages.playNext)}
                {playSubtitle ? ` · ${playSubtitle}` : ''}
              </Button>
            ) : null}
            {tmdbId ? (
              <Button
                as="a"
                buttonType="default"
                href={`/tv/${tmdbId}`}
                onClick={() => onClose()}
              >
                {intl.formatMessage(messages.viewDetails)}
              </Button>
            ) : null}
          </div>

          {!series ? (
            <LoadingSpinner />
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {series.seasons.map((season) => (
                  <button
                    key={season.jellyfinSeasonId}
                    type="button"
                    onClick={() => setSelectedSeasonId(season.jellyfinSeasonId)}
                    className={`rounded-md px-3 py-1.5 text-sm ${
                      selectedSeasonId === season.jellyfinSeasonId
                        ? 'bg-indigo-600 text-white'
                        : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                    }`}
                  >
                    {season.name}
                  </button>
                ))}
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-400">
                    {intl.formatMessage(messages.episodes)}
                  </h3>
                  {canManage && managedTitle ? (
                    <Button
                      buttonType="default"
                      buttonSize="sm"
                      onClick={() => onManage?.(managedTitle)}
                    >
                      {intl.formatMessage(messages.manageInSonarr)}
                    </Button>
                  ) : null}
                </div>
                {!episodes && !episodesError ? (
                  <LoadingSpinner />
                ) : episodesError ? (
                  <p className="text-sm text-red-400">
                    {intl.formatMessage(messages.loadFailed)}
                  </p>
                ) : !episodes?.episodes.length ? (
                  <p className="text-sm text-gray-400">
                    {intl.formatMessage(messages.emptySeason)}
                  </p>
                ) : (
                  <ul className="divide-y divide-gray-700 rounded-md border border-gray-700">
                    {episodes.episodes.map((episode) => {
                      const watched =
                        episodeWatchOverrides.get(episode.jellyfinItemId) ??
                        Boolean(episode.watched);
                      return (
                        <li
                          key={episode.jellyfinItemId}
                          className="flex items-center gap-3 px-3 py-2"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-gray-100">
                              {episode.subtitle ? `${episode.subtitle} · ` : ''}
                              {episode.name}
                            </div>
                            {watched ? (
                              <div className="text-xs text-gray-500">
                                {intl.formatMessage(messages.watched)}
                              </div>
                            ) : episode.progressPercent ? (
                              <div className="mt-1 h-1 w-full overflow-hidden rounded bg-gray-700">
                                <div
                                  className="h-full bg-indigo-500"
                                  style={{
                                    width: `${episode.progressPercent}%`,
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
                                setEpisodeWatchOverrides((current) => {
                                  const next = new Map(current);
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
                              onClick={(event) =>
                                playEpisode(
                                  event,
                                  episode.jellyfinItemId,
                                  `${title} ${episode.subtitle ?? episode.name}`,
                                  episode.mediaUrl!
                                )
                              }
                            >
                              {intl.formatMessage(messages.play)}
                            </Button>
                          ) : null}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </SlideOver>
  );
};

export default LibrarySeriesPanel;
