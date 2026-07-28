import AirDateBadge from '@app/components/AirDateBadge';
import CachedImage from '@app/components/Common/CachedImage';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import RequestModal from '@app/components/RequestModal';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import defineMessages from '@app/utils/defineMessages';
import { quickRequestTvEpisodes } from '@app/utils/quickRequest';
import { ArrowDownTrayIcon, CheckIcon } from '@heroicons/react/24/outline';
import type { EpisodeSelection } from '@server/interfaces/api/requestInterfaces';
import type { SeasonWithEpisodes } from '@server/models/Tv';
import { useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.TvDetails.Season', {
  somethingwentwrong: 'Something went wrong while retrieving season data.',
  noepisodes: 'Episode list unavailable.',
  request: 'Request',
  requesting: 'Requesting…',
  requested: 'Requested',
  requestSuccess: '<strong>{episode}</strong> requested successfully!',
  requestError: 'Quick request failed. Opening request options.',
});

type SeasonProps = {
  seasonNumber: number;
  tvId: number;
  episodeRequestsEnabled?: boolean;
  requestedEpisodeIds?: number[];
  onRequestComplete?: () => void;
};

const Season = ({
  seasonNumber,
  tvId,
  episodeRequestsEnabled = false,
  requestedEpisodeIds = [],
  onRequestComplete,
}: SeasonProps) => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { hasPermission } = useUser();
  const { data, error, mutate } = useSWR<SeasonWithEpisodes>(
    `/api/v1/tv/${tvId}/season/${seasonNumber}`
  );
  const [requestingEpisodeId, setRequestingEpisodeId] = useState<
    number | undefined
  >();
  const [locallyRequestedIds, setLocallyRequestedIds] = useState<number[]>([]);
  const [fallbackSelection, setFallbackSelection] = useState<
    EpisodeSelection | undefined
  >();
  const requestedIds = useMemo(
    () => new Set([...requestedEpisodeIds, ...locallyRequestedIds]),
    [locallyRequestedIds, requestedEpisodeIds]
  );
  const canRequest =
    episodeRequestsEnabled &&
    hasPermission([Permission.REQUEST, Permission.REQUEST_TV], { type: 'or' });

  const requestEpisode = async (episodeId: number, episodeLabel: string) => {
    if (requestingEpisodeId || requestedIds.has(episodeId)) {
      return;
    }
    setRequestingEpisodeId(episodeId);
    try {
      await quickRequestTvEpisodes({
        tmdbId: tvId,
        selection: { type: 'single', episodeTvdbId: episodeId },
      });
      setLocallyRequestedIds((ids) => [...ids, episodeId]);
      addToast(
        <span>
          {intl.formatMessage(messages.requestSuccess, {
            episode: episodeLabel,
            strong: (message: React.ReactNode) => <strong>{message}</strong>,
          })}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );
      await mutate();
      onRequestComplete?.();
    } catch {
      addToast(intl.formatMessage(messages.requestError), {
        appearance: 'warning',
        autoDismiss: true,
      });
      setFallbackSelection({ type: 'single', episodeTvdbId: episodeId });
    } finally {
      setRequestingEpisodeId(undefined);
    }
  };

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <div>{intl.formatMessage(messages.somethingwentwrong)}</div>;
  }

  return (
    <>
      <RequestModal
        show={!!fallbackSelection}
        type="tv"
        tmdbId={tvId}
        initialRequestScope="episodes"
        initialEpisodeSelection={fallbackSelection}
        onCancel={() => setFallbackSelection(undefined)}
        onComplete={() => {
          if (fallbackSelection?.type === 'single') {
            setLocallyRequestedIds((ids) => [
              ...ids,
              fallbackSelection.episodeTvdbId,
            ]);
          }
          setFallbackSelection(undefined);
          onRequestComplete?.();
        }}
      />
      <div className="flex flex-col justify-center divide-y divide-gray-700">
        {data.episodes.length === 0 ? (
          <p>{intl.formatMessage(messages.noepisodes)}</p>
        ) : (
          data.episodes
            .slice()
            .reverse()
            .map((episode) => {
              const episodeCode = `S${String(seasonNumber).padStart(
                2,
                '0'
              )}E${String(episode.episodeNumber).padStart(2, '0')}`;
              const isRequested = requestedIds.has(episode.id);
              const isRequesting = requestingEpisodeId === episode.id;
              return (
                <div
                  className="group flex flex-col gap-4 py-4 xl:flex-row xl:items-center"
                  key={`season-${seasonNumber}-episode-${episode.episodeNumber}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-col space-y-2 xl:flex-row xl:items-center xl:space-x-2 xl:space-y-0">
                      <h3 className="text-lg">
                        {episode.episodeNumber} - {episode.name}
                      </h3>
                      {episode.airDate && (
                        <AirDateBadge airDate={episode.airDate} />
                      )}
                    </div>
                    {episode.overview && <p>{episode.overview}</p>}
                  </div>
                  {canRequest && (
                    <button
                      type="button"
                      data-testid={`episode-quick-request-${episode.id}`}
                      disabled={isRequested || isRequesting}
                      onClick={() =>
                        void requestEpisode(
                          episode.id,
                          `${episodeCode} — ${episode.name}`
                        )
                      }
                      className={`inline-flex h-9 shrink-0 items-center justify-center rounded-md border px-3 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 focus:ring-offset-gray-900 disabled:cursor-default ${
                        isRequested
                          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                          : 'border-indigo-400/40 bg-indigo-500/10 text-indigo-200 hover:border-indigo-400 hover:bg-indigo-500 hover:text-white'
                      }`}
                      aria-label={`${intl.formatMessage(
                        isRequested ? messages.requested : messages.request
                      )} ${episodeCode}`}
                    >
                      {isRequested ? (
                        <CheckIcon className="mr-1.5 h-4 w-4" />
                      ) : (
                        <ArrowDownTrayIcon className="mr-1.5 h-4 w-4" />
                      )}
                      {intl.formatMessage(
                        isRequested
                          ? messages.requested
                          : isRequesting
                            ? messages.requesting
                            : messages.request
                      )}
                    </button>
                  )}
                  {episode.stillPath && (
                    <div className="relative aspect-video xl:h-32">
                      <CachedImage
                        type="tmdb"
                        className="rounded-lg object-contain"
                        src={episode.stillPath}
                        alt=""
                        fill
                      />
                    </div>
                  )}
                </div>
              );
            })
        )}
      </div>
    </>
  );
};

export default Season;
