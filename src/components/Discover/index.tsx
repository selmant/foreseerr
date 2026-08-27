import Button from '@app/components/Common/Button';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import Tooltip from '@app/components/Common/Tooltip';
import AnilistListSlider from '@app/components/Discover/AnilistListSlider';
import AnilistSlider from '@app/components/Discover/AnilistSlider';
import AnilistUserSlider from '@app/components/Discover/AnilistUserSlider';
import CreateSlider from '@app/components/Discover/CreateSlider';
import DiscoverSliderEdit from '@app/components/Discover/DiscoverSliderEdit';
import MdblistListSlider from '@app/components/Discover/MdblistListSlider';
import MovieGenreSlider from '@app/components/Discover/MovieGenreSlider';
import NetworkSlider from '@app/components/Discover/NetworkSlider';
import PlexWatchlistSlider from '@app/components/Discover/PlexWatchlistSlider';
import RecentRequestsSlider from '@app/components/Discover/RecentRequestsSlider';
import RecentlyAddedSlider from '@app/components/Discover/RecentlyAddedSlider';
import SimklSlider from '@app/components/Discover/SimklSlider';
import StudioSlider from '@app/components/Discover/StudioSlider';
import TraktHistorySlider from '@app/components/Discover/TraktHistorySlider';
import TraktListSlider from '@app/components/Discover/TraktListSlider';
import TraktRecommendationsSlider from '@app/components/Discover/TraktRecommendationsSlider';
import TraktWatchlistSlider from '@app/components/Discover/TraktWatchlistSlider';
import TvGenreSlider from '@app/components/Discover/TvGenreSlider';
import { sliderTitles } from '@app/components/Discover/constants';
import MediaSlider from '@app/components/MediaSlider';
import { encodeURIExtraParams } from '@app/hooks/useDiscover';
import useToasts from '@app/hooks/useToasts';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { Transition } from '@headlessui/react';
import {
  ArrowDownOnSquareIcon,
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  PencilIcon,
  PlusIcon,
} from '@heroicons/react/24/solid';
import { DiscoverSliderType } from '@server/constants/discover';
import type DiscoverSlider from '@server/entity/DiscoverSlider';
import axios from 'axios';
import { useEffect, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

const messages = defineMessages('components.Discover', {
  discover: 'Discover',
  emptywatchlist:
    'Media added to your <PlexWatchlistSupportLink>Plex Watchlist</PlexWatchlistSupportLink> will appear here.',
  resettodefault: 'Reset to Default',
  resetwarning:
    'Reset all sliders to default. This will also delete any custom sliders!',
  updatesuccess: 'Updated discover customization settings.',
  updatefailed:
    'Something went wrong updating the discover customization settings.',
  resetsuccess: 'Successfully reset discover customization settings.',
  resetfailed:
    'Something went wrong resetting the discover customization settings.',
  customizediscover: 'Customize Discover',
  stopediting: 'Stop Editing',
  createnewslider: 'Create New Slider',
});

const Discover = () => {
  const intl = useIntl();
  const { hasPermission } = useUser();
  const { addToast } = useToasts();
  const {
    data: discoverData,
    error: discoverError,
    mutate,
  } = useSWR<DiscoverSlider[]>('/api/v1/settings/discover');
  const [sliders, setSliders] = useState<Partial<DiscoverSlider>[]>([]);
  const [isEditing, setIsEditing] = useState(false);

  // We need to sync the state here so that we can modify the changes locally without commiting
  // anything to the server until the user decides to save the changes
  useEffect(() => {
    if (discoverData && !isEditing) {
      setSliders(discoverData);
    }
  }, [discoverData, isEditing]);

  const hasChanged = () => !Object.is(discoverData, sliders);

  const updateSliders = async () => {
    try {
      await axios.post('/api/v1/settings/discover', sliders);

      addToast(intl.formatMessage(messages.updatesuccess), {
        appearance: 'success',
        autoDismiss: true,
      });
      setIsEditing(false);
      mutate();
    } catch {
      addToast(intl.formatMessage(messages.updatefailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const resetSliders = async () => {
    try {
      await axios.get('/api/v1/settings/discover/reset');

      addToast(intl.formatMessage(messages.resetsuccess), {
        appearance: 'success',
        autoDismiss: true,
      });
      setIsEditing(false);
      mutate();
    } catch {
      addToast(intl.formatMessage(messages.resetfailed), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const now = new Date();
  const offset = now.getTimezoneOffset();
  const upcomingDate = new Date(now.getTime() - offset * 60 * 1000)
    .toISOString()
    .split('T')[0];

  if (!discoverData && !discoverError) {
    return <LoadingSpinner />;
  }

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.discover)} />
      {hasPermission(Permission.ADMIN) && (
        <>
          {isEditing && (
            <div className="my-6 rounded-lg bg-gray-800">
              <div className="flex items-center space-x-2 rounded-t-lg border-l border-r border-t border-gray-800 bg-gray-900 p-4 text-lg font-semibold text-gray-400">
                <PlusIcon className="w-6" />
                <span data-testid="create-slider-header">
                  {intl.formatMessage(messages.createnewslider)}
                </span>
              </div>
              <div className="p-4">
                <CreateSlider
                  onCreate={async () => {
                    const newSliders = await mutate();

                    if (newSliders) {
                      setSliders(newSliders);
                    }
                  }}
                />
              </div>
            </div>
          )}
          <Transition
            show={!isEditing}
            enter="transition-opacity duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="transition-opacity duration-300"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
            className="absolute-bottom-shift fixed right-6 z-50 flex items-center sm:bottom-8"
          >
            <button
              onClick={() => setIsEditing(true)}
              data-testid="discover-start-editing"
              className="h-12 w-12 rounded-full border-2 border-gray-600 bg-gray-700/90 p-3 text-gray-400 shadow transition-all hover:bg-gray-700"
            >
              <PencilIcon className="h-full w-full" />
            </button>
          </Transition>
          <Transition
            show={isEditing}
            enter="transition duration-300"
            enterFrom="opacity-0 translate-y-6"
            enterTo="opacity-100 translate-y-0"
            leave="transition duration-300"
            leaveFrom="opacity-100 translate-y-0"
            leaveTo="opacity-0 translate-y-6"
            className="safe-shift-edit-menu fixed left-0 right-0 z-50 flex flex-col items-center justify-end space-x-0 space-y-2 border-t border-gray-700 bg-gray-800/80 p-4 backdrop-blur sm:bottom-0 sm:flex-row sm:space-x-3 sm:space-y-0"
          >
            <Button
              buttonType="default"
              onClick={() => setIsEditing(false)}
              className="w-full sm:w-auto"
            >
              <ArrowUturnLeftIcon />
              <span>{intl.formatMessage(messages.stopediting)}</span>
            </Button>
            <Tooltip content={intl.formatMessage(messages.resetwarning)}>
              <ConfirmButton
                onClick={() => resetSliders()}
                confirmText={intl.formatMessage(globalMessages.areyousure)}
                className="w-full sm:w-auto"
              >
                <ArrowPathIcon />
                <span>{intl.formatMessage(messages.resettodefault)}</span>
              </ConfirmButton>
            </Tooltip>
            <Button
              buttonType="primary"
              type="submit"
              disabled={!hasChanged()}
              onClick={() => updateSliders()}
              data-testid="discover-customize-submit"
              className="w-full sm:w-auto"
            >
              <ArrowDownOnSquareIcon />
              <span>{intl.formatMessage(globalMessages.save)}</span>
            </Button>
          </Transition>
        </>
      )}
      {(isEditing ? sliders : discoverData)?.map((slider, index) => {
        let sliderComponent: React.ReactNode;

        switch (slider.type) {
          case DiscoverSliderType.RECENTLY_ADDED:
            sliderComponent = <RecentlyAddedSlider />;
            break;
          case DiscoverSliderType.RECENT_REQUESTS:
            sliderComponent = <RecentRequestsSlider />;
            break;
          case DiscoverSliderType.PLEX_WATCHLIST:
            sliderComponent = <PlexWatchlistSlider />;
            break;
          case DiscoverSliderType.TRENDING:
            sliderComponent = (
              <MediaSlider
                sliderKey="trending"
                title={intl.formatMessage(sliderTitles.trending)}
                url="/api/v1/discover/trending"
                linkUrl="/discover/trending"
              />
            );
            break;
          case DiscoverSliderType.POPULAR_MOVIES:
            sliderComponent = (
              <MediaSlider
                sliderKey="popular-movies"
                title={intl.formatMessage(sliderTitles.popularmovies)}
                url="/api/v1/discover/movies"
                linkUrl="/discover/movies"
              />
            );
            break;
          case DiscoverSliderType.MOVIE_GENRES:
            sliderComponent = <MovieGenreSlider />;
            break;
          case DiscoverSliderType.UPCOMING_MOVIES:
            sliderComponent = (
              <MediaSlider
                sliderKey="upcoming"
                title={intl.formatMessage(sliderTitles.upcoming)}
                linkUrl={`/discover/movies?primaryReleaseDateGte=${upcomingDate}`}
                url="/api/v1/discover/movies"
                extraParams={`primaryReleaseDateGte=${upcomingDate}`}
              />
            );
            break;
          case DiscoverSliderType.STUDIOS:
            sliderComponent = <StudioSlider />;
            break;
          case DiscoverSliderType.POPULAR_TV:
            sliderComponent = (
              <MediaSlider
                sliderKey="popular-tv"
                title={intl.formatMessage(sliderTitles.populartv)}
                url="/api/v1/discover/tv"
                linkUrl="/discover/tv"
              />
            );
            break;
          case DiscoverSliderType.TV_GENRES:
            sliderComponent = <TvGenreSlider />;
            break;
          case DiscoverSliderType.UPCOMING_TV:
            sliderComponent = (
              <MediaSlider
                sliderKey="upcoming-tv"
                title={intl.formatMessage(sliderTitles.upcomingtv)}
                linkUrl={`/discover/tv?firstAirDateGte=${upcomingDate}`}
                url="/api/v1/discover/tv"
                extraParams={`firstAirDateGte=${upcomingDate}`}
              />
            );
            break;
          case DiscoverSliderType.NETWORKS:
            sliderComponent = <NetworkSlider />;
            break;
          case DiscoverSliderType.TMDB_MOVIE_KEYWORD:
            sliderComponent = (
              <MediaSlider
                sliderKey={`custom-slider-${slider.id}`}
                title={slider.title ?? ''}
                url="/api/v1/discover/movies"
                extraParams={
                  slider.data
                    ? `keywords=${encodeURIExtraParams(slider.data)}`
                    : ''
                }
                linkUrl={`/discover/movies?keywords=${slider.data}`}
              />
            );
            break;
          case DiscoverSliderType.TMDB_TV_KEYWORD:
            sliderComponent = (
              <MediaSlider
                sliderKey={`custom-slider-${slider.id}`}
                title={slider.title ?? ''}
                url="/api/v1/discover/tv"
                extraParams={
                  slider.data
                    ? `keywords=${encodeURIExtraParams(slider.data)}`
                    : ''
                }
                linkUrl={`/discover/tv?keywords=${slider.data}`}
              />
            );
            break;
          case DiscoverSliderType.TMDB_MOVIE_GENRE:
            sliderComponent = (
              <MediaSlider
                sliderKey={`custom-slider-${slider.id}`}
                title={slider.title ?? ''}
                url={`/api/v1/discover/movies`}
                extraParams={`genre=${slider.data}`}
                linkUrl={`/discover/movies?genre=${slider.data}`}
              />
            );
            break;
          case DiscoverSliderType.TMDB_TV_GENRE:
            sliderComponent = (
              <MediaSlider
                sliderKey={`custom-slider-${slider.id}`}
                title={slider.title ?? ''}
                url={`/api/v1/discover/tv`}
                extraParams={`genre=${slider.data}`}
                linkUrl={`/discover/tv?genre=${slider.data}`}
              />
            );
            break;
          case DiscoverSliderType.TMDB_STUDIO:
            sliderComponent = (
              <MediaSlider
                sliderKey={`custom-slider-${slider.id}`}
                title={slider.title ?? ''}
                url={`/api/v1/discover/movies/studio/${slider.data}`}
                linkUrl={`/discover/movies/studio/${slider.data}`}
              />
            );
            break;
          case DiscoverSliderType.TMDB_NETWORK:
            sliderComponent = (
              <MediaSlider
                sliderKey={`custom-slider-${slider.id}`}
                title={slider.title ?? ''}
                url={`/api/v1/discover/tv/network/${slider.data}`}
                linkUrl={`/discover/tv/network/${slider.data}`}
              />
            );
            break;
          case DiscoverSliderType.TMDB_SEARCH:
            sliderComponent = (
              <MediaSlider
                sliderKey={`custom-slider-${slider.id}`}
                title={slider.title ?? ''}
                url="/api/v1/search"
                extraParams={`query=${slider.data}`}
                linkUrl={`/search?query=${slider.data}`}
              />
            );
            break;
          case DiscoverSliderType.TMDB_MOVIE_STREAMING_SERVICES:
            sliderComponent = (
              <MediaSlider
                sliderKey={`custom-slider-${slider.id}`}
                title={slider.title ?? ''}
                url="/api/v1/discover/movies"
                extraParams={`watchRegion=${
                  slider.data?.split(',')[0]
                }&watchProviders=${slider.data?.split(',')[1]}`}
                linkUrl={`/discover/movies?watchRegion=${
                  slider.data?.split(',')[0]
                }&watchProviders=${slider.data?.split(',')[1]}`}
              />
            );
            break;
          case DiscoverSliderType.TMDB_TV_STREAMING_SERVICES:
            sliderComponent = (
              <MediaSlider
                sliderKey={`custom-slider-${slider.id}`}
                title={slider.title ?? ''}
                url="/api/v1/discover/tv"
                extraParams={`watchRegion=${
                  slider.data?.split(',')[0]
                }&watchProviders=${slider.data?.split(',')[1]}`}
                linkUrl={`/discover/tv?watchRegion=${
                  slider.data?.split(',')[0]
                }&watchProviders=${slider.data?.split(',')[1]}`}
              />
            );
            break;
          case DiscoverSliderType.TRAKT_RECOMMENDATIONS:
            sliderComponent = <TraktRecommendationsSlider />;
            break;
          case DiscoverSliderType.TRAKT_WATCHLIST:
            sliderComponent = <TraktWatchlistSlider />;
            break;
          case DiscoverSliderType.TRAKT_HISTORY:
            sliderComponent = <TraktHistorySlider />;
            break;
          case DiscoverSliderType.TRAKT_LIST:
            sliderComponent = (
              <TraktListSlider
                sliderKey={`custom-slider-${slider.id}`}
                title={slider.title ?? ''}
                url={slider.data ?? ''}
              />
            );
            break;
          case DiscoverSliderType.SIMKL_PLAN_TO_WATCH:
            sliderComponent = (
              <SimklSlider
                title={intl.formatMessage(sliderTitles.simklplantowatch)}
                endpoint="/api/v1/discover/simkl/library?status=plantowatch"
                linkUrl="/discover/simkl?status=plantowatch"
                sliderKey="simkl-plan-to-watch"
                requiresLink
              />
            );
            break;
          case DiscoverSliderType.SIMKL_WATCHING:
            sliderComponent = (
              <SimklSlider
                title={intl.formatMessage(sliderTitles.simklwatching)}
                endpoint="/api/v1/discover/simkl/library?status=watching"
                linkUrl="/discover/simkl?status=watching"
                sliderKey="simkl-watching"
                requiresLink
              />
            );
            break;
          case DiscoverSliderType.SIMKL_ON_HOLD:
            sliderComponent = (
              <SimklSlider
                title={intl.formatMessage(sliderTitles.simklonhold)}
                endpoint="/api/v1/discover/simkl/library?status=hold"
                linkUrl="/discover/simkl?status=hold"
                sliderKey="simkl-on-hold"
                requiresLink
              />
            );
            break;
          case DiscoverSliderType.SIMKL_COMPLETED:
            sliderComponent = (
              <SimklSlider
                title={intl.formatMessage(sliderTitles.simklcompleted)}
                endpoint="/api/v1/discover/simkl/library?status=completed"
                linkUrl="/discover/simkl?status=completed"
                sliderKey="simkl-completed"
                requiresLink
              />
            );
            break;
          case DiscoverSliderType.SIMKL_DROPPED:
            sliderComponent = (
              <SimklSlider
                title={intl.formatMessage(sliderTitles.simkldropped)}
                endpoint="/api/v1/discover/simkl/library?status=dropped"
                linkUrl="/discover/simkl?status=dropped"
                sliderKey="simkl-dropped"
                requiresLink
              />
            );
            break;
          case DiscoverSliderType.SIMKL_TRENDING:
            sliderComponent = (
              <SimklSlider
                title={intl.formatMessage(sliderTitles.simkltrending)}
                endpoint="/api/v1/discover/simkl/trending"
                linkUrl="/discover/simkl?view=trending"
                sliderKey="simkl-trending"
              />
            );
            break;
          case DiscoverSliderType.SIMKL_BEST_TV:
            sliderComponent = (
              <SimklSlider
                title={intl.formatMessage(sliderTitles.simklbesttv)}
                endpoint="/api/v1/discover/simkl/best?mediaType=tv"
                linkUrl="/discover/simkl?view=best-tv"
                sliderKey="simkl-best-tv"
              />
            );
            break;
          case DiscoverSliderType.SIMKL_BEST_ANIME:
            sliderComponent = (
              <SimklSlider
                title={intl.formatMessage(sliderTitles.simklbestanime)}
                endpoint="/api/v1/discover/simkl/best?mediaType=anime"
                linkUrl="/discover/simkl?view=best-anime"
                sliderKey="simkl-best-anime"
              />
            );
            break;
          case DiscoverSliderType.SIMKL_NEW_TV_PREMIERES:
            sliderComponent = (
              <SimklSlider
                title={intl.formatMessage(sliderTitles.simklnewtvpremieres)}
                endpoint="/api/v1/discover/simkl/premieres?mediaType=tv&window=new"
                linkUrl="/discover/simkl?view=new-tv-premieres"
                sliderKey="simkl-new-tv-premieres"
              />
            );
            break;
          case DiscoverSliderType.SIMKL_UPCOMING_TV_PREMIERES:
            sliderComponent = (
              <SimklSlider
                title={intl.formatMessage(
                  sliderTitles.simklupcomingtvpremieres
                )}
                endpoint="/api/v1/discover/simkl/premieres?mediaType=tv&window=upcoming"
                linkUrl="/discover/simkl?view=upcoming-tv-premieres"
                sliderKey="simkl-upcoming-tv-premieres"
              />
            );
            break;
          case DiscoverSliderType.SIMKL_NEW_ANIME_PREMIERES:
            sliderComponent = (
              <SimklSlider
                title={intl.formatMessage(sliderTitles.simklnewanimepremieres)}
                endpoint="/api/v1/discover/simkl/premieres?mediaType=anime&window=new"
                linkUrl="/discover/simkl?view=new-anime-premieres"
                sliderKey="simkl-new-anime-premieres"
              />
            );
            break;
          case DiscoverSliderType.SIMKL_UPCOMING_ANIME_PREMIERES:
            sliderComponent = (
              <SimklSlider
                title={intl.formatMessage(
                  sliderTitles.simklupcominganimepremieres
                )}
                endpoint="/api/v1/discover/simkl/premieres?mediaType=anime&window=upcoming"
                linkUrl="/discover/simkl?view=upcoming-anime-premieres"
                sliderKey="simkl-upcoming-anime-premieres"
              />
            );
            break;
          case DiscoverSliderType.ANILIST_TRENDING:
            sliderComponent = (
              <AnilistSlider
                title={intl.formatMessage(sliderTitles.anilisttrending)}
                endpoint="/api/v1/discover/anilist/trending"
                linkUrl="/discover/anilist/trending"
                sliderKey="anilist-trending"
              />
            );
            break;
          case DiscoverSliderType.ANILIST_SEASON:
            sliderComponent = (
              <AnilistSlider
                title={intl.formatMessage(sliderTitles.anilistseason)}
                endpoint="/api/v1/discover/anilist/season"
                linkUrl="/discover/anilist/season"
                sliderKey="anilist-season"
              />
            );
            break;
          case DiscoverSliderType.ANILIST_POPULAR:
            sliderComponent = (
              <AnilistSlider
                title={intl.formatMessage(sliderTitles.anilistpopular)}
                endpoint="/api/v1/discover/anilist/popular"
                linkUrl="/discover/anilist/popular"
                sliderKey="anilist-popular"
              />
            );
            break;
          case DiscoverSliderType.ANILIST_TOP:
            sliderComponent = (
              <AnilistSlider
                title={intl.formatMessage(sliderTitles.anilisttop)}
                endpoint="/api/v1/discover/anilist/top"
                linkUrl="/discover/anilist/top"
                sliderKey="anilist-top"
              />
            );
            break;
          case DiscoverSliderType.ANILIST_NEXT_SEASON:
            sliderComponent = (
              <AnilistSlider
                title={intl.formatMessage(sliderTitles.anilistnextseason)}
                endpoint="/api/v1/discover/anilist/next-season"
                linkUrl="/discover/anilist/next-season"
                sliderKey="anilist-next-season"
              />
            );
            break;
          case DiscoverSliderType.ANILIST_WATCHING:
            sliderComponent = <AnilistUserSlider list="watching" />;
            break;
          case DiscoverSliderType.ANILIST_PLANNING:
            sliderComponent = <AnilistUserSlider list="planning" />;
            break;
          case DiscoverSliderType.ANILIST_COMPLETED:
            sliderComponent = <AnilistUserSlider list="completed" />;
            break;
          case DiscoverSliderType.ANILIST_LIST:
            sliderComponent = (
              <AnilistListSlider
                sliderKey={`custom-slider-${slider.id}`}
                title={slider.title ?? ''}
                name={slider.data ?? ''}
              />
            );
            break;
          case DiscoverSliderType.MDBLIST_LIST:
            sliderComponent = (
              <MdblistListSlider
                sliderKey={`custom-slider-${slider.id}`}
                title={slider.title ?? ''}
                url={slider.data ?? ''}
              />
            );
            break;
        }

        if (isEditing) {
          return (
            <DiscoverSliderEdit
              key={`discover-slider-${slider.id}-edit`}
              slider={slider}
              onDelete={async () => {
                const newSliders = await mutate();

                if (newSliders) {
                  setSliders(newSliders);
                }
              }}
              onEnable={() => {
                const tempSliders = sliders.slice();
                tempSliders[index].enabled = !tempSliders[index].enabled;
                setSliders(tempSliders);
              }}
              onPositionUpdate={(updatedItemId, position, hasClickedArrows) => {
                const originalPosition = sliders.findIndex(
                  (item) => item.id === updatedItemId
                );
                const originalItem = sliders[originalPosition];

                const tempSliders = sliders.slice();

                tempSliders.splice(originalPosition, 1);
                if (hasClickedArrows) {
                  tempSliders.splice(
                    position === 'Above' ? index - 1 : index + 1,
                    0,
                    originalItem
                  );
                } else {
                  tempSliders.splice(
                    position === 'Above' && index > originalPosition
                      ? Math.max(index - 1, 0)
                      : index,
                    0,
                    originalItem
                  );
                }

                setSliders(tempSliders);
              }}
              disableUpButton={index === 0}
              disableDownButton={index === sliders.length - 1}
            >
              {sliderComponent}
            </DiscoverSliderEdit>
          );
        }

        if (!slider.enabled) {
          return null;
        }

        return (
          <div key={`discover-slider-${slider.id}`}>{sliderComponent}</div>
        );
      })}
    </>
  );
};

export default Discover;
