import Spinner from '@app/assets/spinner.svg';
import BlocklistModal from '@app/components/BlocklistModal';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import RatingBadges from '@app/components/Common/RatingBadges';
import StatusBadgeMini from '@app/components/Common/StatusBadgeMini';
import Tooltip from '@app/components/Common/Tooltip';
import RequestModal from '@app/components/RequestModal';
import ErrorCard from '@app/components/TitleCard/ErrorCard';
import MediaActionControls from '@app/components/TitleCard/MediaActionControls';
import Placeholder from '@app/components/TitleCard/Placeholder';
import { useNativeRuntime } from '@app/context/NativeRuntimeContext';
import { useIsTouch } from '@app/hooks/useIsTouch';
import { useMediaActionCapabilities } from '@app/hooks/useMediaActions';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { Permission, UserType, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import {
  quickRequestMovie,
  quickRequestTvSeasons,
} from '@app/utils/quickRequest';
import { withProperties } from '@app/utils/typeHelpers';
import { Transition } from '@headlessui/react';
import {
  ArrowDownTrayIcon,
  EyeIcon,
  EyeSlashIcon,
  MinusCircleIcon,
  QueueListIcon,
  StarIcon,
} from '@heroicons/react/24/outline';
import { ChevronDownIcon, CogIcon, PlayIcon } from '@heroicons/react/24/solid';
import type { RatingResponse } from '@server/api/ratings';
import { MediaStatus } from '@server/constants/media';
import type { Watchlist } from '@server/entity/Watchlist';
import type { MediaType } from '@server/models/Search';
import axios from 'axios';
import Link from 'next/link';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useIntl } from 'react-intl';
import { mutate } from 'swr';

interface TitleCardProps {
  id: number;
  image?: string;
  summary?: string;
  year?: string;
  title: string;
  userScore?: number;
  ratings?: RatingResponse | null;
  mediaType: MediaType;
  status?: MediaStatus;
  canExpand?: boolean;
  inProgress?: boolean;
  isAddedToWatchlist?: number | boolean;
  mutateParent?: () => void;
  /** Owned-media / Library shelves: hide request chrome, optional play. */
  libraryMode?: boolean;
  subtitle?: string;
  progressPercent?: number;
  jellyfinItemId?: string | null;
  playItemId?: string | null;
  jellyfinSeriesId?: string | null;
  mediaUrl?: string | null;
  onLibraryOpenSeries?: (jellyfinSeriesId: string) => void;
  onLibraryManage?: () => void;
}

const messages = defineMessages('components.TitleCard', {
  addToWatchList: 'Add to watchlist',
  watchlistSuccess:
    '<strong>{title}</strong> added to watchlist  successfully!',
  watchlistDeleted:
    '<strong>{title}</strong> Removed from watchlist  successfully!',
  watchlistCancel: 'watchlist for <strong>{title}</strong> canceled.',
  watchlistError: 'Something went wrong. Please try again.',
  requestseason1: 'Season 1',
  requestall: 'Request All',
  selectseasons: 'Select Seasons…',
  requestepisodes: 'Episodes…',
  seasons: 'Seasons',
  season1Success: 'Season 1 requested successfully!',
  season1Error: 'Could not request season 1. Opening the full request form.',
  requestAllSuccess: 'All seasons requested successfully!',
  requestAllError:
    'Could not request all seasons. Opening the full request form.',
  movieSuccess: 'Requested successfully!',
  movieError: 'Could not request. Opening the full request form.',
  play: 'Play',
  manage: 'Manage in {service}',
  moreRequestOptions: 'More request options',
});

const TitleCard = ({
  id,
  image,
  summary,
  year,
  title,
  userScore,
  ratings,
  status,
  mediaType,
  isAddedToWatchlist = false,
  inProgress = false,
  canExpand = false,
  mutateParent,
  libraryMode = false,
  subtitle,
  progressPercent,
  jellyfinItemId,
  playItemId,
  jellyfinSeriesId,
  mediaUrl,
  onLibraryOpenSeries,
  onLibraryManage,
}: TitleCardProps) => {
  const isTouch = useIsTouch();
  const intl = useIntl();
  const settings = useSettings();
  const { user, hasPermission } = useUser();
  const { play } = useNativeRuntime();
  const [isUpdating, setIsUpdating] = useState(false);
  const { data: mediaActionCapabilities } = useMediaActionCapabilities();
  const surfaceCapabilities =
    mediaType === 'movie'
      ? mediaActionCapabilities?.movie
      : mediaActionCapabilities?.tv;
  const mediaActionsEnabled = Boolean(
    (surfaceCapabilities?.watched || surfaceCapabilities?.rating) &&
    (mediaType === 'movie' || mediaType === 'tv')
  );
  const [currentStatus, setCurrentStatus] = useState(status);
  const [showDetail, setShowDetail] = useState(false);
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [initialSeasonSelection, setInitialSeasonSelection] = useState<
    'none' | 'all'
  >('none');
  const [initialRequestScope, setInitialRequestScope] = useState<
    'seasons' | 'episodes'
  >('seasons');
  const [showTvMenu, setShowTvMenu] = useState(false);
  const [tvMenuPos, setTvMenuPos] = useState<{
    top: number;
    left: number;
  } | null>(null);
  const [isQuickRequesting, setIsQuickRequesting] = useState(false);
  const { addToast } = useToasts();
  const [toggleWatchlist, setToggleWatchlist] =
    useState<boolean>(!isAddedToWatchlist);
  const [showBlocklistModal, setShowBlocklistModal] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const tvMenuButtonRef = useRef<HTMLButtonElement>(null);
  const tvMenuRef = useRef<HTMLDivElement>(null);

  // Just to get the year from the date
  if (year) {
    year = year.slice(0, 4);
  }

  useEffect(() => {
    setCurrentStatus(status);
  }, [status]);

  const requestComplete = useCallback((newStatus: MediaStatus) => {
    setCurrentStatus(newStatus);
    setShowRequestModal(false);
    setInitialSeasonSelection('none');
    setInitialRequestScope('seasons');
  }, []);

  const openTvRequestModal = (
    selection: 'none' | 'all' = 'none',
    scope: 'seasons' | 'episodes' = 'seasons'
  ) => {
    setShowTvMenu(false);
    setInitialSeasonSelection(selection);
    setInitialRequestScope(scope);
    setShowRequestModal(true);
  };

  const toggleTvMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (showTvMenu) {
      setShowTvMenu(false);
      return;
    }
    const rect = tvMenuButtonRef.current?.getBoundingClientRect();
    if (rect) {
      // Open upward so the menu sits over the poster, not under the card edge.
      setTvMenuPos({
        top: rect.top - 8,
        left: Math.min(rect.right, window.innerWidth - 8),
      });
    }
    setShowTvMenu(true);
  };

  useEffect(() => {
    if (!showTvMenu) {
      return;
    }
    const onDoc = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        tvMenuRef.current?.contains(target) ||
        tvMenuButtonRef.current?.contains(target)
      ) {
        return;
      }
      setShowTvMenu(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [showTvMenu]);

  const requestSeason1 = async () => {
    if (isQuickRequesting) {
      return;
    }
    setIsQuickRequesting(true);
    setIsUpdating(true);
    try {
      await quickRequestTvSeasons({ tmdbId: id, seasons: [1] });
      addToast(intl.formatMessage(messages.season1Success), {
        appearance: 'success',
        autoDismiss: true,
      });
      setCurrentStatus(MediaStatus.PENDING);
      mutateParent?.();
    } catch {
      addToast(intl.formatMessage(messages.season1Error), {
        appearance: 'warning',
        autoDismiss: true,
      });
      openTvRequestModal('none');
    } finally {
      setIsQuickRequesting(false);
      setIsUpdating(false);
    }
  };

  const requestAllSeasons = async () => {
    if (isQuickRequesting) {
      return;
    }
    setShowTvMenu(false);
    setIsQuickRequesting(true);
    setIsUpdating(true);
    try {
      await quickRequestTvSeasons({ tmdbId: id, seasons: 'all' });
      addToast(intl.formatMessage(messages.requestAllSuccess), {
        appearance: 'success',
        autoDismiss: true,
      });
      setCurrentStatus(MediaStatus.PENDING);
      mutateParent?.();
    } catch {
      addToast(intl.formatMessage(messages.requestAllError), {
        appearance: 'warning',
        autoDismiss: true,
      });
      openTvRequestModal('all');
    } finally {
      setIsQuickRequesting(false);
      setIsUpdating(false);
    }
  };

  const requestMovieInstant = async () => {
    if (isQuickRequesting) {
      return;
    }
    setIsQuickRequesting(true);
    setIsUpdating(true);
    try {
      await quickRequestMovie({ tmdbId: id });
      addToast(intl.formatMessage(messages.movieSuccess), {
        appearance: 'success',
        autoDismiss: true,
      });
      setCurrentStatus(MediaStatus.PENDING);
      mutateParent?.();
    } catch {
      addToast(intl.formatMessage(messages.movieError), {
        appearance: 'warning',
        autoDismiss: true,
      });
      setShowRequestModal(true);
    } finally {
      setIsQuickRequesting(false);
      setIsUpdating(false);
    }
  };

  const requestUpdating = useCallback(
    (status: boolean) => setIsUpdating(status),
    []
  );

  const closeBlocklistModal = useCallback(
    () => setShowBlocklistModal(false),
    []
  );

  const onClickWatchlistBtn = async (): Promise<void> => {
    setIsUpdating(true);
    try {
      const response = await axios.post<Watchlist>('/api/v1/watchlist', {
        tmdbId: id,
        mediaType,
        title,
      });
      mutate('/api/v1/discover/watchlist');
      if (response.data) {
        addToast(
          <span>
            {intl.formatMessage(messages.watchlistSuccess, {
              title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'success', autoDismiss: true }
        );
      }
    } catch {
      addToast(intl.formatMessage(messages.watchlistError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsUpdating(false);
      setToggleWatchlist((prevState) => !prevState);
    }
  };

  const onClickDeleteWatchlistBtn = async (): Promise<void> => {
    setIsUpdating(true);
    try {
      const response = await axios.delete<Watchlist>(
        `/api/v1/watchlist/${id}?mediaType=${mediaType}`
      );

      if (response.status === 204) {
        addToast(
          <span>
            {intl.formatMessage(messages.watchlistDeleted, {
              title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'info', autoDismiss: true }
        );
      }
    } catch {
      addToast(intl.formatMessage(messages.watchlistError), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsUpdating(false);
      mutate('/api/v1/discover/watchlist');
      if (mutateParent) {
        mutateParent();
      }
      setToggleWatchlist((prevState) => !prevState);
    }
  };

  const onClickHideItemBtn = async (): Promise<void> => {
    setIsUpdating(true);
    const topNode = cardRef.current;

    if (topNode) {
      try {
        if (mediaType === 'collection') {
          await axios.post(`/api/v1/blocklist/collection/${id}`);
        } else {
          await axios.post('/api/v1/blocklist', {
            tmdbId: id,
            mediaType,
            title,
            user: user?.id,
          });
        }
        addToast(
          <span>
            {intl.formatMessage(globalMessages.blocklistSuccess, {
              title,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'success', autoDismiss: true }
        );
        setCurrentStatus(MediaStatus.BLOCKLISTED);
        if (mutateParent) {
          mutateParent();
        }
      } catch (e) {
        if (e?.response?.status === 412) {
          addToast(
            <span>
              {intl.formatMessage(globalMessages.blocklistDuplicateError, {
                title,
                strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
              })}
            </span>,
            { appearance: 'info', autoDismiss: true }
          );
        } else {
          addToast(intl.formatMessage(globalMessages.blocklistError), {
            appearance: 'error',
            autoDismiss: true,
          });
        }
      }

      setIsUpdating(false);
      closeBlocklistModal();
    } else {
      addToast(intl.formatMessage(globalMessages.blocklistError), {
        appearance: 'error',
        autoDismiss: true,
      });
    }
  };

  const onClickShowBlocklistBtn = async (): Promise<void> => {
    setIsUpdating(true);
    const topNode = cardRef.current;

    if (topNode) {
      try {
        if (mediaType === 'collection') {
          const res = await axios.delete(`/api/v1/blocklist/collection/${id}`);

          if (res.status === 204) {
            addToast(
              <span>
                {intl.formatMessage(globalMessages.removeFromBlocklistSuccess, {
                  title,
                  strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
                })}
              </span>,
              { appearance: 'success', autoDismiss: true }
            );
            setCurrentStatus(MediaStatus.UNKNOWN);
            if (mutateParent) {
              mutateParent();
            }
          } else {
            addToast(intl.formatMessage(globalMessages.blocklistError), {
              appearance: 'error',
              autoDismiss: true,
            });
          }
        } else {
          const res = await axios.delete(
            `/api/v1/blocklist/${id}?mediaType=${mediaType}`
          );

          if (res.status === 204) {
            addToast(
              <span>
                {intl.formatMessage(globalMessages.removeFromBlocklistSuccess, {
                  title,
                  strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
                })}
              </span>,
              { appearance: 'success', autoDismiss: true }
            );
            setCurrentStatus(MediaStatus.UNKNOWN);
            if (mutateParent) {
              mutateParent();
            }
          } else {
            addToast(intl.formatMessage(globalMessages.blocklistError), {
              appearance: 'error',
              autoDismiss: true,
            });
          }
        }
      } catch {
        addToast(intl.formatMessage(globalMessages.blocklistError), {
          appearance: 'error',
          autoDismiss: true,
        });
      }
    } else {
      addToast(intl.formatMessage(globalMessages.blocklistError), {
        appearance: 'error',
        autoDismiss: true,
      });
    }

    setIsUpdating(false);
  };

  const closeModal = useCallback(() => {
    setShowRequestModal(false);
    setInitialSeasonSelection('none');
    setInitialRequestScope('seasons');
  }, []);

  const showRequestButton =
    !libraryMode &&
    hasPermission(
      [
        Permission.REQUEST,
        mediaType === 'movie' || mediaType === 'collection'
          ? Permission.REQUEST_MOVIE
          : Permission.REQUEST_TV,
      ],
      { type: 'or' }
    );

  const showHideButton =
    !libraryMode &&
    hasPermission([Permission.MANAGE_BLOCKLIST], {
      type: 'or',
    });

  // Series rows need a concrete episode id; the series Jellyfin id is not playable.
  const libraryPlayId =
    mediaType === 'tv'
      ? playItemId || undefined
      : playItemId || jellyfinItemId || undefined;
  const showLibraryPlay = Boolean(libraryMode && libraryPlayId);
  const detailHref =
    mediaType === 'movie'
      ? `/movie/${id}`
      : mediaType === 'collection'
        ? `/collection/${id}`
        : `/tv/${id}`;
  const playFallbackUrl = mediaUrl || detailHref;

  const onLibraryPlay = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (
      libraryPlayId &&
      play({
        provider: 'jellyfin',
        itemId: libraryPlayId,
        fallbackUrl: playFallbackUrl,
        label: title,
        quality: 'standard',
      })
    ) {
      return;
    }
    if (mediaUrl) {
      window.open(mediaUrl, '_blank', 'noopener,noreferrer');
    }
  };

  const onLibraryCardNavigate = (event: React.MouseEvent) => {
    if (
      libraryMode &&
      mediaType === 'tv' &&
      jellyfinSeriesId &&
      onLibraryOpenSeries
    ) {
      event.preventDefault();
      onLibraryOpenSeries(jellyfinSeriesId);
    }
  };

  const onLibraryManageClick = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onLibraryManage?.();
  };

  return (
    <div
      className={canExpand ? 'w-full' : 'w-36 sm:w-36 md:w-44'}
      data-testid="title-card"
      ref={cardRef}
    >
      <RequestModal
        tmdbId={id}
        show={showRequestModal}
        type={
          mediaType === 'movie'
            ? 'movie'
            : mediaType === 'collection'
              ? 'collection'
              : 'tv'
        }
        initialSeasonSelection={
          mediaType === 'tv' ? initialSeasonSelection : 'none'
        }
        initialRequestScope={initialRequestScope}
        onComplete={requestComplete}
        onUpdating={requestUpdating}
        onCancel={closeModal}
      />
      <BlocklistModal
        tmdbId={id}
        type={
          mediaType === 'movie'
            ? 'movie'
            : mediaType === 'collection'
              ? 'collection'
              : 'tv'
        }
        show={showBlocklistModal}
        onCancel={closeBlocklistModal}
        onComplete={onClickHideItemBtn}
        isUpdating={isUpdating}
      />
      <div
        className={`relative transform-gpu cursor-default overflow-hidden rounded-xl bg-gray-800 bg-cover outline-none ring-1 transition duration-300 ${
          showDetail
            ? 'scale-105 shadow-lg ring-gray-500'
            : 'scale-100 shadow ring-gray-700'
        }`}
        style={{
          paddingBottom: '150%',
        }}
        onMouseEnter={() => {
          if (!isTouch) {
            setShowDetail(true);
          }
        }}
        onMouseLeave={() => {
          if (!showTvMenu) {
            setShowDetail(false);
          }
        }}
        onClick={() => setShowDetail(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            setShowDetail(true);
          }
        }}
        role="link"
        tabIndex={0}
      >
        <div className="absolute inset-0 h-full w-full overflow-hidden">
          <CachedImage
            type="tmdb"
            className="absolute inset-0 h-full w-full"
            alt=""
            src={
              image
                ? `https://image.tmdb.org/t/p/w300_and_h450_face${image}`
                : `/images/seerr_poster_not_found_logo_top.png`
            }
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            fill
          />
          {progressPercent != null && progressPercent > 0 ? (
            <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-20 h-1 bg-black/70">
              <div
                className="h-full bg-indigo-500"
                style={{ width: `${Math.min(100, progressPercent)}%` }}
              />
            </div>
          ) : null}
          <div className="absolute left-0 right-0 z-30 flex items-start justify-between gap-2 p-2">
            <div className="flex min-w-0 flex-col items-start gap-1.5">
              <div
                className={`pointer-events-none self-start rounded-full border shadow-md ${
                  mediaType === 'movie' || mediaType === 'collection'
                    ? 'border-blue-500 bg-blue-600/80'
                    : 'border-purple-600 bg-purple-600/80'
                }`}
              >
                <div className="flex h-4 items-center px-2 py-2 text-center text-xs font-medium uppercase tracking-wider text-white sm:h-5">
                  {mediaType === 'movie'
                    ? intl.formatMessage(globalMessages.movie)
                    : mediaType === 'collection'
                      ? intl.formatMessage(globalMessages.collection)
                      : intl.formatMessage(globalMessages.tvshow)}
                </div>
              </div>
              <RatingBadges
                item={{ tmdbRating: userScore, ratings }}
                badgeSettings={settings.currentSettings.ratingBadges}
                compact
                expanded={showDetail}
              />
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              {showDetail && currentStatus !== MediaStatus.BLOCKLISTED && (
                <div className="flex flex-col gap-1">
                  {mediaActionsEnabled && (
                    <MediaActionControls
                      tmdbId={id}
                      mediaType={mediaType as 'movie' | 'tv'}
                      enabled={mediaActionsEnabled}
                      onStatusChange={mutateParent}
                    />
                  )}
                  {user?.userType !== UserType.PLEX &&
                    !libraryMode &&
                    (toggleWatchlist ? (
                      <Button
                        buttonType={'ghost'}
                        className="z-40"
                        buttonSize={'sm'}
                        onClick={onClickWatchlistBtn}
                      >
                        <StarIcon className={'h-3 text-amber-300'} />
                      </Button>
                    ) : (
                      <Button
                        className="z-40"
                        buttonSize={'sm'}
                        onClick={onClickDeleteWatchlistBtn}
                      >
                        <MinusCircleIcon className={'h-3'} />
                      </Button>
                    ))}
                  {showHideButton &&
                    currentStatus !== MediaStatus.PROCESSING &&
                    currentStatus !== MediaStatus.AVAILABLE &&
                    currentStatus !== MediaStatus.PARTIALLY_AVAILABLE &&
                    currentStatus !== MediaStatus.PENDING && (
                      <Button
                        buttonType={'ghost'}
                        className="z-40"
                        buttonSize={'sm'}
                        onClick={() => setShowBlocklistModal(true)}
                      >
                        <EyeSlashIcon className={'h-3'} />
                      </Button>
                    )}
                </div>
              )}
              {showDetail &&
                showHideButton &&
                currentStatus == MediaStatus.BLOCKLISTED && (
                  <Tooltip
                    content={intl.formatMessage(
                      globalMessages.removefromBlocklist
                    )}
                  >
                    <Button
                      buttonType={'ghost'}
                      className="z-40"
                      buttonSize={'sm'}
                      onClick={() => onClickShowBlocklistBtn()}
                    >
                      <EyeIcon className={'h-3'} />
                    </Button>
                  </Tooltip>
                )}
              {currentStatus && currentStatus !== MediaStatus.UNKNOWN && (
                <div className="pointer-events-none z-40 flex">
                  <StatusBadgeMini
                    status={currentStatus}
                    inProgress={inProgress}
                    shrink
                  />
                </div>
              )}
            </div>
          </div>
          <Transition
            as={Fragment}
            show={isUpdating}
            enter="transition-opacity ease-in-out duration-300"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="transition-opacity ease-in-out duration-300"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="absolute inset-0 z-40 flex items-center justify-center rounded-xl bg-gray-800/75 text-white">
              <Spinner className="h-10 w-10" />
            </div>
          </Transition>

          <Transition
            as={Fragment}
            show={!image || showDetail || showRequestModal || showTvMenu}
            enter="transition-opacity"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="transition-opacity"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <div className="absolute inset-0 overflow-hidden rounded-xl">
              <Link
                href={detailHref}
                onClick={onLibraryCardNavigate}
                className="absolute inset-0 h-full w-full cursor-pointer overflow-hidden text-left"
                style={{
                  background:
                    'linear-gradient(180deg, rgba(45, 55, 72, 0.4) 0%, rgba(45, 55, 72, 0.9) 100%)',
                }}
              >
                <div
                  className={`flex h-full w-full flex-col ${
                    showDetail ? 'pt-28' : 'pt-14'
                  }`}
                >
                  <div
                    className={`flex min-h-0 flex-1 flex-col justify-end overflow-hidden px-2 text-white ${
                      showLibraryPlay ||
                      !showRequestButton ||
                      (currentStatus &&
                        currentStatus !== MediaStatus.UNKNOWN &&
                        currentStatus !== MediaStatus.DELETED)
                        ? showLibraryPlay
                          ? 'pb-11'
                          : 'pb-2'
                        : 'pb-11'
                    }`}
                  >
                    {year && (
                      <div className="shrink-0 text-sm font-medium">{year}</div>
                    )}

                    <h1
                      className="shrink-0 whitespace-normal text-xl font-bold leading-tight"
                      style={{
                        WebkitLineClamp: 2,
                        display: '-webkit-box',
                        overflow: 'hidden',
                        WebkitBoxOrient: 'vertical',
                        wordBreak: 'break-word',
                      }}
                      data-testid="title-card-title"
                    >
                      {title}
                    </h1>
                    {subtitle ? (
                      <div className="shrink-0 truncate text-xs text-gray-200">
                        {subtitle}
                      </div>
                    ) : null}
                    {summary && (
                      <div className="min-h-0 shrink overflow-hidden">
                        <div
                          className="whitespace-normal text-xs"
                          style={{
                            WebkitLineClamp:
                              !showRequestButton ||
                              (currentStatus &&
                                currentStatus !== MediaStatus.UNKNOWN &&
                                currentStatus !== MediaStatus.DELETED)
                                ? 5
                                : 3,
                            display: '-webkit-box',
                            overflow: 'hidden',
                            WebkitBoxOrient: 'vertical',
                            wordBreak: 'break-word',
                          }}
                        >
                          {summary}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </Link>

              <div className="absolute bottom-0 left-0 right-0 z-40 flex justify-between gap-1 px-2 py-2">
                {showLibraryPlay ? (
                  <Button
                    buttonType="primary"
                    buttonSize="sm"
                    className="z-40 flex-1"
                    onClick={onLibraryPlay}
                  >
                    <PlayIcon className="h-4 w-4" />{' '}
                    <span>{intl.formatMessage(messages.play)}</span>
                  </Button>
                ) : null}
                {libraryMode && onLibraryManage ? (
                  <Tooltip
                    content={intl.formatMessage(messages.manage, {
                      service: mediaType === 'movie' ? 'Radarr' : 'Sonarr',
                    })}
                  >
                    <Button
                      buttonType="default"
                      buttonSize="sm"
                      className="z-40 shrink-0"
                      aria-label={intl.formatMessage(messages.manage, {
                        service: mediaType === 'movie' ? 'Radarr' : 'Sonarr',
                      })}
                      onClick={onLibraryManageClick}
                    >
                      <CogIcon className="!mr-0 h-4 w-4" />
                    </Button>
                  </Tooltip>
                ) : null}
                {showRequestButton &&
                  (!currentStatus ||
                    currentStatus === MediaStatus.UNKNOWN ||
                    currentStatus === MediaStatus.DELETED) &&
                  (mediaType === 'tv' &&
                  settings.currentSettings.seriesInstantRequestEnabled ? (
                    <div className="relative z-40 flex w-full">
                      <button
                        type="button"
                        disabled={isQuickRequesting}
                        className="button-md relative z-40 inline-flex h-7 flex-1 items-center justify-center rounded-l-md border border-indigo-500 bg-indigo-600/80 px-2 text-xs font-medium leading-5 text-white transition duration-150 ease-in-out hover:bg-indigo-600 focus:z-50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setShowTvMenu(false);
                          requestSeason1();
                        }}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                        }}
                      >
                        <ArrowDownTrayIcon className="h-4 w-4" />
                        <span className="ml-1">
                          {isQuickRequesting
                            ? intl.formatMessage(globalMessages.requesting)
                            : intl.formatMessage(messages.requestseason1)}
                        </span>
                      </button>
                      <button
                        ref={tvMenuButtonRef}
                        type="button"
                        disabled={isQuickRequesting}
                        aria-expanded={showTvMenu}
                        aria-haspopup="menu"
                        aria-label={intl.formatMessage(
                          messages.moreRequestOptions
                        )}
                        className="button-md relative z-40 inline-flex h-7 items-center justify-center rounded-r-md border border-l-0 border-indigo-500 bg-indigo-600/80 px-2 text-white transition duration-150 ease-in-out hover:bg-indigo-600 focus:z-50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={toggleTvMenu}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                        }}
                      >
                        <ChevronDownIcon className="h-4 w-4" />
                      </button>
                      {showTvMenu &&
                        tvMenuPos &&
                        createPortal(
                          <div
                            ref={tvMenuRef}
                            role="menu"
                            className="fixed z-[100] w-44 -translate-x-full -translate-y-full rounded-md border border-indigo-500 bg-indigo-600 p-1 shadow-lg"
                            style={{
                              top: tvMenuPos.top,
                              left: tvMenuPos.left,
                            }}
                          >
                            <button
                              type="button"
                              role="menuitem"
                              className="flex w-full items-center rounded px-3 py-2 text-left text-sm text-white hover:bg-indigo-500"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                void requestAllSeasons();
                              }}
                            >
                              <ArrowDownTrayIcon className="mr-2 h-4 w-4" />
                              {intl.formatMessage(messages.requestall)}
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="flex w-full items-center rounded px-3 py-2 text-left text-sm text-white hover:bg-indigo-500"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                window.setTimeout(
                                  () => openTvRequestModal('none'),
                                  0
                                );
                              }}
                            >
                              <ArrowDownTrayIcon className="mr-2 h-4 w-4" />
                              {intl.formatMessage(messages.selectseasons)}
                            </button>
                            {settings.currentSettings
                              .episodeRequestsEnabled && (
                              <button
                                type="button"
                                role="menuitem"
                                data-testid="title-card-request-episodes"
                                className="flex w-full items-center rounded px-3 py-2 text-left text-sm text-white hover:bg-indigo-500"
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  window.setTimeout(
                                    () =>
                                      openTvRequestModal('none', 'episodes'),
                                    0
                                  );
                                }}
                              >
                                <QueueListIcon className="mr-2 h-4 w-4" />
                                {intl.formatMessage(messages.requestepisodes)}
                              </button>
                            )}
                          </div>,
                          document.body
                        )}
                    </div>
                  ) : mediaType === 'tv' &&
                    settings.currentSettings.episodeRequestsEnabled ? (
                    <div className="relative z-40 flex w-full overflow-hidden rounded-md border border-indigo-500 bg-indigo-600/80">
                      <button
                        type="button"
                        className="flex h-7 flex-1 items-center justify-center px-2 text-xs font-medium text-white transition hover:bg-indigo-600"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          openTvRequestModal('none', 'seasons');
                        }}
                      >
                        <ArrowDownTrayIcon className="mr-1 h-4 w-4" />
                        {intl.formatMessage(messages.seasons)}
                      </button>
                      <button
                        type="button"
                        data-testid="title-card-request-episodes"
                        className="flex h-7 flex-1 items-center justify-center border-l border-indigo-400 px-2 text-xs font-medium text-white transition hover:bg-indigo-600"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          openTvRequestModal('none', 'episodes');
                        }}
                      >
                        <QueueListIcon className="mr-1 h-4 w-4" />
                        {intl.formatMessage(messages.requestepisodes)}
                      </button>
                    </div>
                  ) : mediaType === 'tv' ? (
                    <Button
                      buttonType="primary"
                      buttonSize="sm"
                      className="z-40 w-full"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        openTvRequestModal('none');
                      }}
                    >
                      <ArrowDownTrayIcon />{' '}
                      <span>{intl.formatMessage(messages.selectseasons)}</span>
                    </Button>
                  ) : mediaType === 'movie' || mediaType === 'collection' ? (
                    <Button
                      buttonType="primary"
                      buttonSize="sm"
                      disabled={isQuickRequesting}
                      className="z-40 w-full"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (mediaType === 'movie') {
                          if (
                            settings.currentSettings.movieInstantRequestEnabled
                          ) {
                            void requestMovieInstant();
                          } else {
                            setShowRequestModal(true);
                          }
                        } else {
                          setShowRequestModal(true);
                        }
                      }}
                    >
                      <ArrowDownTrayIcon />{' '}
                      <span>
                        {isQuickRequesting
                          ? intl.formatMessage(globalMessages.requesting)
                          : intl.formatMessage(globalMessages.request)}
                      </span>
                    </Button>
                  ) : null)}
              </div>
            </div>
          </Transition>
        </div>
      </div>
    </div>
  );
};

export default withProperties(TitleCard, { Placeholder, ErrorCard });
