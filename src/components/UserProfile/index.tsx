import ImageFader from '@app/components/Common/ImageFader';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import ProgressCircle from '@app/components/Common/ProgressCircle';
import AnilistUserSlider from '@app/components/Discover/AnilistUserSlider';
import { sliderTitles } from '@app/components/Discover/constants';
import SimklSlider from '@app/components/Discover/SimklSlider';
import TraktHistorySlider from '@app/components/Discover/TraktHistorySlider';
import TraktWatchlistSlider from '@app/components/Discover/TraktWatchlistSlider';
import RequestCard from '@app/components/RequestCard';
import Slider from '@app/components/Slider';
import TmdbTitleCard, {
  watchlistTitleCardProps,
} from '@app/components/TitleCard/TmdbTitleCard';
import ProfileHeader from '@app/components/UserProfile/ProfileHeader';
import useRequestSeeMorePosters from '@app/hooks/useRequestSeeMorePosters';
import useRouteQuery from '@app/hooks/useRouteQuery';
import useSeeMorePosters from '@app/hooks/useSeeMorePosters';
import { Permission, UserType, useUser } from '@app/hooks/useUser';
import ErrorPage from '@app/pages/_error';
import defineMessages from '@app/utils/defineMessages';
import { formatBytes } from '@app/utils/numberHelpers';
import { ArrowRightCircleIcon } from '@heroicons/react/24/outline';
import type { WatchlistResponse } from '@shared/interfaces/api/discoverInterfaces';
import type {
  QuotaResponse,
  SonarrStorageResponse,
  UserRequestsResponse,
  UserWatchDataResponse,
} from '@shared/interfaces/api/userInterfaces';
import type { MovieDetails } from '@shared/models/Movie';
import type { TvDetails } from '@shared/models/Tv';
import { useCallback, useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import { Link } from 'react-router';
import useSWR from 'swr';

const messages = defineMessages('components.UserProfile', {
  recentrequests: 'Recent Requests',
  limit: '{remaining} of {limit}',
  requestsperdays: '{limit} remaining',
  unlimited: 'Unlimited',
  totalrequests: 'Total Requests',
  pastdays: '{type} (past {days} days)',
  movierequests: 'Movie Requests',
  seriesrequest: 'Series Requests',
  recentlywatched: 'Recently Watched',
  plexwatchlist: 'Plex Watchlist',
  localWatchlist: "{username}'s Watchlist",
  emptywatchlist:
    'Media added to your <PlexWatchlistSupportLink>Plex Watchlist</PlexWatchlistSupportLink> will appear here.',
  sonarrStorage: 'Sonarr Storage',
  sonarrUsage:
    '{episodes, plural, one {# episode} other {# episodes}} in {series, plural, one {# series} other {# series}}',
  sonarrServerUsage: '{server}: {size}',
});

type MediaTitle = MovieDetails | TvDetails;

const UserProfile = () => {
  const intl = useIntl();
  const routeQuery = useRouteQuery();
  const { user, error } = useUser({
    id: Number(routeQuery.userId),
  });
  const { user: currentUser, hasPermission: currentHasPermission } = useUser();
  const [availableTitles, setAvailableTitles] = useState<
    Record<number, MediaTitle>
  >({});

  const requestsEndpoint =
    user &&
    (user.id === currentUser?.id ||
      currentHasPermission(
        [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
        { type: 'or' }
      ))
      ? `/api/v1/user/${user.id}/requests`
      : null;
  const { data: requests, error: requestError } = useSWR<UserRequestsResponse>(
    requestsEndpoint ? `${requestsEndpoint}?take=10&skip=0` : null
  );
  const requestsSeeMorePosters = useRequestSeeMorePosters(
    requestsEndpoint,
    requests
  );
  const { data: quota } = useSWR<QuotaResponse>(
    user &&
      (user.id === currentUser?.id ||
        currentHasPermission(
          [Permission.MANAGE_USERS, Permission.MANAGE_REQUESTS],
          { type: 'and' }
        ))
      ? `/api/v1/user/${user.id}/quota`
      : null
  );
  // Only Sonarr 5 servers that tag requests report it.
  const { data: sonarrStorage } = useSWR<SonarrStorageResponse>(
    quota && user ? `/api/v1/user/${user.id}/sonarr-storage` : null,
    { revalidateOnFocus: false }
  );
  const storageServers = sonarrStorage?.servers ?? [];
  const storage = storageServers.length
    ? storageServers.reduce(
        (total, server) => ({
          sizeOnDisk: total.sizeOnDisk + server.sizeOnDisk,
          episodeCount: total.episodeCount + server.episodeCount,
          seriesCount: total.seriesCount + server.seriesCount,
        }),
        { sizeOnDisk: 0, episodeCount: 0, seriesCount: 0 }
      )
    : undefined;
  const { data: watchData, error: watchDataError } =
    useSWR<UserWatchDataResponse>(
      user?.userType === UserType.PLEX &&
        (user.id === currentUser?.id || currentHasPermission(Permission.ADMIN))
        ? `/api/v1/user/${user.id}/watch_data`
        : null
    );

  const watchlistEndpoint =
    user?.id === currentUser?.id ||
    currentHasPermission(
      [Permission.MANAGE_REQUESTS, Permission.WATCHLIST_VIEW],
      {
        type: 'or',
      }
    )
      ? `/api/v1/user/${user?.id}/watchlist`
      : null;
  const { data: watchlistItems, error: watchlistError } =
    useSWR<WatchlistResponse>(watchlistEndpoint, {
      revalidateOnMount: true,
    });
  const watchlistSeeMorePosters = useSeeMorePosters(
    watchlistEndpoint,
    watchlistItems
  );

  const updateAvailableTitles = useCallback(
    (requestId: number, mediaTitle: MediaTitle) => {
      setAvailableTitles((titles) => ({
        ...titles,
        [requestId]: mediaTitle,
      }));
    },
    []
  );

  useEffect(() => {
    setAvailableTitles({});
  }, [user?.id]);

  if (!user && !error) {
    return <LoadingSpinner />;
  }

  if (!user) {
    return <ErrorPage statusCode={404} />;
  }

  const watchlistSliderTitle = intl.formatMessage(
    user.userType === UserType.PLEX
      ? messages.plexwatchlist
      : messages.localWatchlist,
    { username: user.displayName }
  );

  return (
    <>
      <PageTitle title={user.displayName} />
      {Object.keys(availableTitles).length > 0 && (
        <div className="absolute -top-16 left-0 right-0 z-0 h-96">
          <ImageFader
            key={user.id}
            isDarker
            backgroundImages={Object.values(availableTitles)
              .filter((media) => media.backdropPath)
              .map(
                (media) =>
                  `https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${media.backdropPath}`
              )
              .slice(0, 6)}
          />
        </div>
      )}
      <ProfileHeader user={user} />
      {quota &&
        (user.id === currentUser?.id ||
          currentHasPermission(
            [Permission.MANAGE_USERS, Permission.MANAGE_REQUESTS],
            { type: 'and' }
          )) && (
          <div className="relative z-40">
            <dl
              className={`mt-5 grid grid-cols-1 gap-5 ${
                storage ? 'sm:grid-cols-2 lg:grid-cols-4' : 'lg:grid-cols-3'
              }`}
            >
              <div className="overflow-hidden rounded-lg bg-gray-800/50 px-4 py-5 shadow ring-1 ring-gray-700 sm:p-6">
                <dt className="truncate text-sm font-bold text-gray-300">
                  {intl.formatMessage(messages.totalrequests)}
                </dt>
                <dd className="mt-1 text-3xl font-semibold text-white">
                  <Link
                    to={
                      currentHasPermission(
                        [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
                        { type: 'or' }
                      )
                        ? `/users/${user?.id}/requests?filter=all`
                        : '/requests'
                    }
                  >
                    {intl.formatNumber(user.requestCount)}
                  </Link>
                </dd>
              </div>
              <div
                className={`overflow-hidden rounded-lg bg-gray-800/50 px-4 py-5 shadow ring-1 ${
                  quota.movie.restricted
                    ? 'bg-gradient-to-t from-red-900 to-transparent ring-red-500'
                    : 'ring-gray-700'
                } sm:p-6`}
              >
                <dt
                  className={`truncate text-sm font-bold ${
                    quota.movie.restricted ? 'text-red-500' : 'text-gray-300'
                  }`}
                >
                  {quota.movie.limit
                    ? intl.formatMessage(messages.pastdays, {
                        type: intl.formatMessage(messages.movierequests),
                        days: quota?.movie.days,
                      })
                    : intl.formatMessage(messages.movierequests)}
                </dt>
                <dd
                  className={`mt-1 flex items-center text-sm ${
                    quota.movie.restricted ? 'text-red-500' : 'text-white'
                  }`}
                >
                  {quota.movie.limit ? (
                    <>
                      <ProgressCircle
                        progress={Math.round(
                          ((quota?.movie.remaining ?? 0) /
                            (quota?.movie.limit ?? 1)) *
                            100
                        )}
                        useHeatLevel
                        className="mr-2 h-8 w-8"
                      />
                      <div>
                        {intl.formatMessage(messages.requestsperdays, {
                          limit: (
                            <span className="text-3xl font-semibold">
                              {intl.formatMessage(messages.limit, {
                                remaining: quota.movie.remaining,
                                limit: quota.movie.limit,
                              })}
                            </span>
                          ),
                        })}
                      </div>
                    </>
                  ) : (
                    <span className="text-3xl font-semibold">
                      {intl.formatMessage(messages.unlimited)}
                    </span>
                  )}
                </dd>
              </div>
              <div
                className={`overflow-hidden rounded-lg bg-gray-800/50 px-4 py-5 shadow ring-1 ${
                  quota.tv.restricted
                    ? 'bg-gradient-to-t from-red-900 to-transparent ring-red-500'
                    : 'ring-gray-700'
                } sm:p-6`}
              >
                <dt
                  className={`truncate text-sm font-bold ${
                    quota.tv.restricted ? 'text-red-500' : 'text-gray-300'
                  }`}
                >
                  {quota.tv.limit
                    ? intl.formatMessage(messages.pastdays, {
                        type: intl.formatMessage(messages.seriesrequest),
                        days: quota?.tv.days,
                      })
                    : intl.formatMessage(messages.seriesrequest)}
                </dt>
                <dd
                  className={`mt-1 flex items-center text-sm ${
                    quota.tv.restricted ? 'text-red-500' : 'text-white'
                  }`}
                >
                  {quota.tv.limit ? (
                    <>
                      <ProgressCircle
                        progress={Math.round(
                          ((quota?.tv.remaining ?? 0) /
                            (quota?.tv.limit ?? 1)) *
                            100
                        )}
                        useHeatLevel
                        className="mr-2 h-8 w-8"
                      />
                      <div>
                        {intl.formatMessage(messages.requestsperdays, {
                          limit: (
                            <span className="text-3xl font-semibold">
                              {intl.formatMessage(messages.limit, {
                                remaining: quota.tv.remaining,
                                limit: quota.tv.limit,
                              })}
                            </span>
                          ),
                        })}
                      </div>
                    </>
                  ) : (
                    <span className="text-3xl font-semibold">
                      {intl.formatMessage(messages.unlimited)}
                    </span>
                  )}
                </dd>
              </div>
              {storage && (
                <div className="overflow-hidden rounded-lg bg-gray-800/50 px-4 py-5 shadow ring-1 ring-gray-700 sm:p-6">
                  <dt className="truncate text-sm font-bold text-gray-300">
                    {intl.formatMessage(messages.sonarrStorage)}
                  </dt>
                  <dd className="mt-1 text-white">
                    <span className="text-3xl font-semibold">
                      {formatBytes(storage.sizeOnDisk)}
                    </span>
                    <div className="mt-1 text-sm text-gray-300">
                      {intl.formatMessage(messages.sonarrUsage, {
                        episodes: storage.episodeCount,
                        series: storage.seriesCount,
                      })}
                    </div>
                    {storageServers.length > 1 && (
                      <ul className="mt-1 text-xs text-gray-400">
                        {storageServers.map((server) => (
                          <li key={`sonarr-storage-${server.id}`}>
                            {intl.formatMessage(messages.sonarrServerUsage, {
                              server: server.name,
                              size: formatBytes(server.sizeOnDisk),
                            })}
                          </li>
                        ))}
                      </ul>
                    )}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        )}
      {(user.id === currentUser?.id ||
        currentHasPermission(
          [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
          { type: 'or' }
        )) &&
        (!requests || !!requests.results.length) &&
        !requestError && (
          <>
            <div className="slider-header">
              <Link
                to={
                  currentHasPermission(
                    [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
                    { type: 'or' }
                  )
                    ? `/users/${user?.id}/requests?filter=all`
                    : '/requests'
                }
                className="slider-title"
              >
                <span>{intl.formatMessage(messages.recentrequests)}</span>
                <ArrowRightCircleIcon />
              </Link>
            </div>
            <Slider
              sliderKey="requests"
              ariaLabel={intl.formatMessage(messages.recentrequests)}
              seeMore={{
                url: currentHasPermission(
                  [Permission.MANAGE_REQUESTS, Permission.REQUEST_VIEW],
                  { type: 'or' }
                )
                  ? `/users/${user.id}/requests?filter=all`
                  : '/requests',
                layout: 'request',
                posters: requestsSeeMorePosters,
              }}
              isLoading={!requests}
              items={(requests?.results ?? []).map((request) => (
                <RequestCard
                  key={`request-slider-item-${request.id}`}
                  request={request}
                  onTitleData={updateAvailableTitles}
                />
              ))}
              placeholder={<RequestCard.Placeholder />}
            />
          </>
        )}
      {(user.id === currentUser?.id ||
        currentHasPermission(
          [Permission.MANAGE_REQUESTS, Permission.WATCHLIST_VIEW],
          { type: 'or' }
        )) &&
        (!watchlistItems ||
          !!watchlistItems.results.length ||
          (user.id === currentUser?.id &&
            (user.settings?.watchlistSyncMovies ||
              user.settings?.watchlistSyncTv))) &&
        !watchlistError && (
          <>
            <div className="slider-header">
              <Link
                to={
                  user.id === currentUser?.id
                    ? '/profile/watchlist'
                    : `/users/${user.id}/watchlist`
                }
                className="slider-title"
              >
                <span>{watchlistSliderTitle}</span>
                <ArrowRightCircleIcon />
              </Link>
            </div>
            <Slider
              sliderKey="watchlist"
              ariaLabel={watchlistSliderTitle}
              seeMore={{
                url:
                  user.id === currentUser?.id
                    ? '/profile/watchlist'
                    : `/users/${user.id}/watchlist`,
                posters: watchlistSeeMorePosters,
              }}
              isLoading={!watchlistItems}
              isEmpty={!!watchlistItems && watchlistItems.results.length === 0}
              emptyMessage={intl.formatMessage(messages.emptywatchlist, {
                PlexWatchlistSupportLink: (msg: React.ReactNode) => (
                  <a
                    href="https://support.plex.tv/articles/universal-watchlist/"
                    className="text-white transition duration-300 hover:underline"
                    target="_blank"
                    rel="noreferrer"
                  >
                    {msg}
                  </a>
                ),
              })}
              items={watchlistItems?.results.map((item) => (
                <TmdbTitleCard
                  key={`watchlist-slider-item-${item.ratingKey}`}
                  {...watchlistTitleCardProps(item)}
                />
              ))}
            />
          </>
        )}
      {user.userType === UserType.PLEX &&
        (user.id === currentUser?.id ||
          currentHasPermission(Permission.ADMIN)) &&
        (!watchData || !!watchData.recentlyWatched?.length) &&
        !watchDataError && (
          <>
            <div className="slider-header">
              <div className="slider-title">
                <span>{intl.formatMessage(messages.recentlywatched)}</span>
              </div>
            </div>
            <Slider
              sliderKey="media"
              isLoading={!watchData}
              items={watchData?.recentlyWatched?.map((item) => (
                <TmdbTitleCard
                  key={`media-slider-item-${item.id}`}
                  id={item.id}
                  tmdbId={item.tmdbId}
                  tvdbId={item.tvdbId}
                  type={item.mediaType}
                />
              ))}
            />
          </>
        )}
      {/* Linked-service lists are only readable for the signed-in user. */}
      {user.id === currentUser?.id && (
        <>
          <TraktWatchlistSlider />
          <TraktHistorySlider />
          <SimklSlider
            title={intl.formatMessage(sliderTitles.simklwatching)}
            endpoint="/api/v1/discover/simkl/library?status=watching"
            linkUrl="/discover/simkl?status=watching"
            sliderKey="profile-simkl-watching"
            requiresLink
          />
          <AnilistUserSlider list="watching" sliderKey="profile-anilist" />
        </>
      )}
    </>
  );
};

export default UserProfile;
