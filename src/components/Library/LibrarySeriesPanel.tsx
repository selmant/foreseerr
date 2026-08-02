import Button from '@app/components/Common/Button';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import SlideOver from '@app/components/Common/SlideOver';
import { useNativeRuntime } from '@app/context/NativeRuntimeContext';
import defineMessages from '@app/utils/defineMessages';
import type {
  LibrarySeasonEpisodesResponse,
  LibrarySeriesDetailResponse,
} from '@server/interfaces/api/libraryInterfaces';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Library.LibrarySeriesPanel', {
  playNext: 'Play next',
  viewDetails: 'View details',
  episodes: 'Episodes',
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
  onClose: () => void;
}

const LibrarySeriesPanel = ({
  show,
  jellyfinSeriesId,
  seedTitle,
  seedTmdbId,
  seedPlayItemId,
  seedSubtitle,
  onClose,
}: LibrarySeriesPanelProps) => {
  const intl = useIntl();
  const { play } = useNativeRuntime();
  const [selectedSeasonId, setSelectedSeasonId] = useState<string | null>(null);

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

  const { data: episodes, error: episodesError } =
    useSWR<LibrarySeasonEpisodesResponse>(
      show && jellyfinSeriesId && selectedSeasonId
        ? `/api/v1/library/series/${jellyfinSeriesId}/seasons/${selectedSeasonId}/episodes`
        : null
    );

  const title = series?.title || seedTitle || 'Series';
  const tmdbId = series?.tmdbId ?? seedTmdbId;
  const playItemId = series?.playItemId || seedPlayItemId;
  const playSubtitle = series?.subtitle || seedSubtitle;
  const statusCode = series?.code ?? episodes?.code;

  const playEpisode = (itemId: string, label: string) => {
    play({
      provider: 'jellyfin',
      itemId,
      fallbackUrl: tmdbId ? `/tv/${tmdbId}` : '/',
      label,
      quality: 'standard',
    });
  };

  return (
    <SlideOver show={show} title={title} onClose={onClose} variant="fast">
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
            {playItemId ? (
              <Button
                buttonType="primary"
                onClick={() => playEpisode(playItemId, playSubtitle || title)}
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
                <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-400">
                  {intl.formatMessage(messages.episodes)}
                </h3>
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
                    {episodes.episodes.map((episode) => (
                      <li
                        key={episode.jellyfinItemId}
                        className="flex items-center gap-3 px-3 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-gray-100">
                            {episode.subtitle ? `${episode.subtitle} · ` : ''}
                            {episode.name}
                          </div>
                          {episode.watched ? (
                            <div className="text-xs text-gray-500">
                              {intl.formatMessage(messages.watched)}
                            </div>
                          ) : episode.progressPercent ? (
                            <div className="mt-1 h-1 w-full overflow-hidden rounded bg-gray-700">
                              <div
                                className="h-full bg-indigo-500"
                                style={{ width: `${episode.progressPercent}%` }}
                              />
                            </div>
                          ) : null}
                        </div>
                        <Button
                          buttonType="primary"
                          buttonSize="sm"
                          onClick={() =>
                            playEpisode(
                              episode.jellyfinItemId,
                              `${title} ${episode.subtitle ?? episode.name}`
                            )
                          }
                        >
                          {intl.formatMessage(messages.play)}
                        </Button>
                      </li>
                    ))}
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
