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
import { useTitleCardBatch } from '@app/components/TitleCard/TitleCardBatchContext';
import { useIsTouch } from '@app/hooks/useIsTouch';
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
  StarIcon,
} from '@heroicons/react/24/outline';
import { ChevronDownIcon } from '@heroicons/react/24/solid';
import type { RatingResponse } from '@server/api/ratings';
import { MediaStatus } from '@server/constants/media';
import type { Watchlist } from '@server/entity/Watchlist';
import type { MediaType } from '@server/models/Search';
import axios from 'axios';
import Link from 'next/link';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useInView } from 'react-intersection-observer';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';

interface TitleCardProps {
  id: number;
  image?: string;
  summary?: string;
  year?: string;
  title: string;
  userScore?: number;
  mediaType: MediaType;
  status?: MediaStatus;
  canExpand?: boolean;
  inProgress?: boolean;
  isAddedToWatchlist?: number | boolean;
  mutateParent?: () => void;
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
  season1Success: 'Season 1 requested successfully!',
  season1Error: 'Could not request season 1. Opening the full request form.',
  requestAllSuccess: 'All seasons requested successfully!',
  requestAllError:
    'Could not request all seasons. Opening the full request form.',
  movieSuccess: 'Requested successfully!',
  movieError: 'Could not request. Opening the full request form.',
});

const TitleCard = ({
  id,
  image,
  summary,
  year,
  title,
  userScore,
  status,
  mediaType,
  isAddedToWatchlist = false,
  inProgress = false,
  canExpand = false,
  mutateParent,
}: TitleCardProps) => {
  const isTouch = useIsTouch();
  const intl = useIntl();
  const settings = useSettings();
  const { user, hasPermission } = useUser();
  const [isUpdating, setIsUpdating] = useState(false);

  const traktLinkKey =
    settings.currentSettings.traktConfigured &&
    settings.currentSettings.mediaActionsTraktEnabled &&
    user
      ? `/api/v1/user/${user.id}/settings/linked-accounts/trakt`
      : null;
  const { data: traktLink } = useSWR<{ connected: boolean }>(traktLinkKey, {
    revalidateOnFocus: false,
  });
  const mediaActionsEnabled = Boolean(
    settings.currentSettings.traktConfigured &&
    settings.currentSettings.mediaActionsTraktEnabled !== false &&
    traktLink?.connected &&
    (mediaType === 'movie' || mediaType === 'tv')
  );
  const [currentStatus, setCurrentStatus] = useState(status);
  const [showDetail, setShowDetail] = useState(false);
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [initialSeasonSelection, setInitialSeasonSelection] = useState<
    'none' | 'all'
  >('none');
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
  const { ref: ratingsRef, inView: ratingsInView } = useInView({
    triggerOnce: true,
    rootMargin: '100px',
  });

  const canFetchRatings =
    (mediaType === 'movie' || mediaType === 'tv') &&
    settings.currentSettings.mdblistConfigured;

  const batch = useTitleCardBatch();
  const batchRatings =
    canFetchRatings && (mediaType === 'movie' || mediaType === 'tv')
      ? batch?.getRatings(mediaType, id)
      : undefined;

  const { data: swrRatingData } = useSWR<RatingResponse>(
    canFetchRatings && ratingsInView && !batch?.active
      ? `/api/v1/${mediaType}/${id}/ratingscombined`
      : null,
    {
      shouldRetryOnError: false,
      revalidateOnFocus: false,
    }
  );
  const ratingData =
    batchRatings !== undefined ? (batchRatings ?? undefined) : swrRatingData;

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
  }, []);

  const openTvRequestModal = (selection: 'none' | 'all' = 'none') => {
    setShowTvMenu(false);
    setInitialSeasonSelection(selection);
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
  }, []);

  const showRequestButton = hasPermission(
    [
      Permission.REQUEST,
      mediaType === 'movie' || mediaType === 'collection'
        ? Permission.REQUEST_MOVIE
        : Permission.REQUEST_TV,
    ],
    { type: 'or' }
  );

  const showHideButton = hasPermission([Permission.MANAGE_BLOCKLIST], {
    type: 'or',
  });

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
        ref={ratingsRef}
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
                item={{ tmdbRating: userScore, ratings: ratingData }}
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
                href={
                  mediaType === 'movie'
                    ? `/movie/${id}`
                    : mediaType === 'collection'
                      ? `/collection/${id}`
                      : `/tv/${id}`
                }
                className="absolute inset-0 h-full w-full cursor-pointer overflow-hidden text-left"
                style={{
                  background:
                    'linear-gradient(180deg, rgba(45, 55, 72, 0.4) 0%, rgba(45, 55, 72, 0.9) 100%)',
                }}
              >
                <div className="flex h-full w-full items-end">
                  <div
                    className={`px-2 text-white ${
                      !showRequestButton ||
                      (currentStatus &&
                        currentStatus !== MediaStatus.UNKNOWN &&
                        currentStatus !== MediaStatus.DELETED)
                        ? 'pb-2'
                        : 'pb-11'
                    }`}
                  >
                    {year && <div className="text-sm font-medium">{year}</div>}

                    <h1
                      className="whitespace-normal text-xl font-bold leading-tight"
                      style={{
                        WebkitLineClamp: 3,
                        display: '-webkit-box',
                        overflow: 'hidden',
                        WebkitBoxOrient: 'vertical',
                        wordBreak: 'break-word',
                      }}
                      data-testid="title-card-title"
                    >
                      {title}
                    </h1>
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
                </div>
              </Link>

              <div className="absolute bottom-0 left-0 right-0 z-40 flex justify-between px-2 py-2">
                {showRequestButton &&
                  (!currentStatus ||
                    currentStatus === MediaStatus.UNKNOWN ||
                    currentStatus === MediaStatus.DELETED) &&
                  (mediaType === 'tv' ? (
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
                        aria-label="More request options"
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
                          </div>,
                          document.body
                        )}
                    </div>
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
                          requestMovieInstant();
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
