import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import CachedImage from '@app/components/Common/CachedImage';
import Modal from '@app/components/Common/Modal';
import type { RequestOverrides } from '@app/components/RequestModal/AdvancedRequester';
import AdvancedRequester from '@app/components/RequestModal/AdvancedRequester';
import QuotaDisplay from '@app/components/RequestModal/QuotaDisplay';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { CheckIcon, MinusIcon } from '@heroicons/react/24/solid';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type { QuotaResponse } from '@server/interfaces/api/userInterfaces';
import { Permission } from '@server/lib/permissions';
import type { Collection } from '@server/models/Collection';
import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';

const messages = defineMessages('components.RequestModal', {
  requestadmin: 'This request will be approved automatically.',
  requestSuccess: '<strong>{title}</strong> requested successfully!',
  requestcollectiontitle: 'Request Collection',
  requestcollection4ktitle: 'Request Collection in 4K',
  requesterror: 'Something went wrong while submitting the request.',
  selectmovies: 'Select Movie(s)',
  selectcollectionmovie: 'Select {title}',
  selectallcollectionmovies: 'Select all requestable movies',
  collectionselectioncount: '{selected} of {total} requestable movies selected',
  clearcollectionselection: 'Clear selection',
  collectionquotahint:
    'Your quota allows {count} more {count, plural, one {movie} other {movies}}. Choose individual movies below.',
  requestmovies: 'Request {count} {count, plural, one {Movie} other {Movies}}',
  requestmovies4k:
    'Request {count} {count, plural, one {Movie} other {Movies}} in 4K',
});

interface RequestModalProps extends React.HTMLAttributes<HTMLDivElement> {
  tmdbId: number;
  is4k?: boolean;
  onCancel?: () => void;
  onComplete?: (newStatus: MediaStatus) => void;
  onUpdating?: (isUpdating: boolean) => void;
}

const CollectionRequestModal = ({
  onCancel,
  onComplete,
  tmdbId,
  onUpdating,
  is4k = false,
}: RequestModalProps) => {
  const [isUpdating, setIsUpdating] = useState(false);
  const requestInFlight = useRef(false);
  const [requestOverrides, setRequestOverrides] =
    useState<RequestOverrides | null>(null);
  const [selectedParts, setSelectedParts] = useState<number[]>([]);
  const { addToast } = useToasts();
  const { data, error } = useSWR<Collection>(`/api/v1/collection/${tmdbId}`, {
    revalidateOnMount: true,
  });
  const intl = useIntl();
  const { user, hasPermission } = useUser();
  const { data: quota } = useSWR<QuotaResponse>(
    user &&
      (!requestOverrides?.user?.id || hasPermission(Permission.MANAGE_USERS))
      ? `/api/v1/user/${requestOverrides?.user?.id ?? user.id}/quota`
      : null
  );

  const currentlyRemaining =
    (quota?.movie.remaining ?? 0) - selectedParts.length;

  const getAllParts = (): number[] => {
    return (data?.parts ?? [])
      .filter((part) => part.mediaInfo?.status !== MediaStatus.BLOCKLISTED)
      .map((part) => part.id);
  };

  const getAllRequestedParts = (): number[] => {
    return (data?.parts ?? [])
      .filter((part) => {
        const status = part.mediaInfo?.[is4k ? 'status4k' : 'status'];
        return (
          status === MediaStatus.AVAILABLE ||
          status === MediaStatus.PROCESSING ||
          (part.mediaInfo?.requests ?? []).some(
            (request) =>
              request.is4k === is4k &&
              request.status !== MediaRequestStatus.DECLINED &&
              request.status !== MediaRequestStatus.COMPLETED
          )
        );
      })
      .map((part) => part.id);
  };

  const isSelectedPart = (tmdbId: number): boolean =>
    selectedParts.includes(tmdbId);

  const togglePart = (tmdbId: number): void => {
    if (requestInFlight.current || !getAllParts().includes(tmdbId)) return;

    // If this part already has a pending request, don't allow it to be toggled
    if (getAllRequestedParts().includes(tmdbId)) {
      return;
    }

    // If there are no more remaining requests available, block toggle
    if (
      quota?.movie.limit &&
      currentlyRemaining <= 0 &&
      !isSelectedPart(tmdbId)
    ) {
      return;
    }

    if (selectedParts.includes(tmdbId)) {
      setSelectedParts((parts) => parts.filter((partId) => partId !== tmdbId));
    } else {
      setSelectedParts((parts) => [...parts, tmdbId]);
    }
  };

  const unrequestedParts = getAllParts().filter(
    (tmdbId) => !getAllRequestedParts().includes(tmdbId)
  );

  const allSelected =
    unrequestedParts.length > 0 &&
    selectedParts.length === unrequestedParts.length;
  const cannotSelectAll = Boolean(
    quota?.movie.limit && (quota.movie.remaining ?? 0) < unrequestedParts.length
  );

  const toggleAllParts = (): void => {
    if (requestInFlight.current || !unrequestedParts.length) return;
    if (allSelected) {
      setSelectedParts([]);
    } else if (!cannotSelectAll) {
      setSelectedParts(unrequestedParts);
    }
  };

  const getPartRequest = (tmdbId: number): MediaRequest | undefined => {
    const part = (data?.parts ?? []).find((part) => part.id === tmdbId);

    return (part?.mediaInfo?.requests ?? []).find(
      (request) =>
        request.is4k === is4k &&
        request.status !== MediaRequestStatus.DECLINED &&
        request.status !== MediaRequestStatus.COMPLETED
    );
  };

  useEffect(() => {
    if (onUpdating) {
      onUpdating(isUpdating);
    }
  }, [isUpdating, onUpdating]);

  const sendRequest = useCallback(async () => {
    if (requestInFlight.current || selectedParts.length === 0) return;
    requestInFlight.current = true;
    setIsUpdating(true);

    try {
      let overrideParams = {};
      if (requestOverrides) {
        overrideParams = {
          serverId: requestOverrides.server,
          profileId: requestOverrides.profile,
          rootFolder: requestOverrides.folder,
          userId: requestOverrides.user?.id,
          tags: requestOverrides.tags,
        };
      }

      await Promise.all(
        (
          data?.parts.filter((part) => selectedParts.includes(part.id)) ?? []
        ).map(async (part) => {
          await axios.post<MediaRequest>('/api/v1/request', {
            mediaId: part.id,
            mediaType: 'movie',
            is4k,
            ...overrideParams,
          });
        })
      );

      if (onComplete) {
        onComplete(
          selectedParts.length === (data?.parts ?? []).length
            ? MediaStatus.UNKNOWN
            : MediaStatus.PARTIALLY_AVAILABLE
        );
        mutate('/api/v1/request/count');
      }

      addToast(
        <span>
          {intl.formatMessage(messages.requestSuccess, {
            title: data?.name,
            strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
          })}
        </span>,
        { appearance: 'success', autoDismiss: true }
      );
    } catch {
      addToast(intl.formatMessage(messages.requesterror), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      requestInFlight.current = false;
      setIsUpdating(false);
    }
  }, [
    requestOverrides,
    data?.parts,
    data?.name,
    onComplete,
    addToast,
    intl,
    selectedParts,
    is4k,
  ]);

  const hasAutoApprove = hasPermission(
    [
      Permission.MANAGE_REQUESTS,
      is4k ? Permission.AUTO_APPROVE_4K : Permission.AUTO_APPROVE,
      is4k ? Permission.AUTO_APPROVE_4K_MOVIE : Permission.AUTO_APPROVE_MOVIE,
    ],
    { type: 'or' }
  );

  const blocklistVisibility = hasPermission(
    [Permission.MANAGE_BLOCKLIST, Permission.VIEW_BLOCKLIST],
    { type: 'or' }
  );

  return (
    <Modal
      stickyActions
      loading={(!data && !error) || !quota}
      backgroundClickable
      onCancel={onCancel}
      onOk={sendRequest}
      title={intl.formatMessage(
        is4k
          ? messages.requestcollection4ktitle
          : messages.requestcollectiontitle
      )}
      subTitle={data?.name}
      okText={
        isUpdating
          ? intl.formatMessage(globalMessages.requesting)
          : selectedParts.length === 0
            ? intl.formatMessage(messages.selectmovies)
            : intl.formatMessage(
                is4k ? messages.requestmovies4k : messages.requestmovies,
                {
                  count: selectedParts.length,
                }
              )
      }
      okDisabled={selectedParts.length === 0}
      okButtonProps={{ 'aria-disabled': isUpdating, 'aria-busy': isUpdating }}
      okButtonType={'primary'}
      backdrop={`https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${data?.backdropPath}`}
    >
      {hasAutoApprove && !quota?.movie.restricted && (
        <div className="mt-6">
          <Alert
            title={intl.formatMessage(messages.requestadmin)}
            type="info"
          />
        </div>
      )}
      {(quota?.movie.limit ?? 0) > 0 && (
        <QuotaDisplay
          mediaType="movie"
          quota={quota?.movie}
          remaining={currentlyRemaining}
          userOverride={
            requestOverrides?.user && requestOverrides.user.id !== user?.id
              ? requestOverrides?.user?.id
              : undefined
          }
        />
      )}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-3">
        <p role="status" className="text-sm text-gray-300">
          {intl.formatMessage(messages.collectionselectioncount, {
            selected: selectedParts.length,
            total: unrequestedParts.length,
          })}
        </p>
        <button
          type="button"
          aria-disabled={isUpdating || selectedParts.length === 0}
          onClick={() => {
            if (!requestInFlight.current && selectedParts.length > 0) {
              setSelectedParts([]);
            }
          }}
          className="min-h-11 rounded-md px-2 text-sm text-indigo-300 underline underline-offset-4 hover:text-indigo-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 aria-disabled:cursor-default aria-disabled:opacity-50"
        >
          {intl.formatMessage(messages.clearcollectionselection)}
        </button>
      </div>
      {cannotSelectAll && (
        <p id="collection-quota-hint" className="mb-2 text-sm text-gray-400">
          {intl.formatMessage(messages.collectionquotahint, {
            count: Math.max(0, quota?.movie.remaining ?? 0),
          })}
        </p>
      )}
      <div className="flex flex-col">
        <div>
          <div className="inline-block min-w-full py-2 align-middle">
            <div className="overflow-hidden border border-gray-700 backdrop-blur sm:rounded-lg">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="w-14 bg-gray-700/80 px-1 py-2 sm:px-3">
                      <button
                        type="button"
                        role="checkbox"
                        aria-label={intl.formatMessage(
                          messages.selectallcollectionmovies
                        )}
                        aria-checked={
                          allSelected
                            ? true
                            : selectedParts.length > 0
                              ? 'mixed'
                              : false
                        }
                        aria-disabled={
                          isUpdating ||
                          !unrequestedParts.length ||
                          (cannotSelectAll && !allSelected)
                        }
                        aria-describedby={
                          cannotSelectAll ? 'collection-quota-hint' : undefined
                        }
                        onClick={toggleAllParts}
                        className="flex min-h-11 min-w-11 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 aria-disabled:cursor-default aria-disabled:opacity-50"
                      >
                        <span
                          aria-hidden="true"
                          className={`flex h-5 w-5 items-center justify-center rounded border ${selectedParts.length > 0 ? 'border-indigo-400 bg-indigo-500 text-white' : 'border-gray-400 bg-gray-800'}`}
                        >
                          {allSelected ? (
                            <CheckIcon className="h-4 w-4" />
                          ) : selectedParts.length > 0 ? (
                            <MinusIcon className="h-4 w-4" />
                          ) : null}
                        </span>
                      </button>
                    </th>
                    <th className="bg-gray-700/80 px-1 py-3 text-left text-xs font-medium uppercase leading-4 tracking-wider text-gray-200 md:px-6">
                      {intl.formatMessage(globalMessages.movie)}
                    </th>
                    <th className="bg-gray-700/80 px-2 py-3 text-left text-xs font-medium uppercase leading-4 tracking-wider text-gray-200 md:px-6">
                      {intl.formatMessage(globalMessages.status)}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-700">
                  {data?.parts
                    .filter((part) => {
                      if (!blocklistVisibility)
                        return (
                          part.mediaInfo?.status !== MediaStatus.BLOCKLISTED
                        );
                      return part;
                    })
                    .map((part) => {
                      const partRequest = getPartRequest(part.id);
                      const partMedia =
                        part.mediaInfo &&
                        part.mediaInfo[is4k ? 'status4k' : 'status'] !==
                          MediaStatus.UNKNOWN &&
                        part.mediaInfo[is4k ? 'status4k' : 'status'] !==
                          MediaStatus.DELETED
                          ? part.mediaInfo
                          : undefined;

                      return (
                        <tr key={`part-${part.id}`}>
                          <td className="px-1 py-3 sm:px-3">
                            <button
                              type="button"
                              role="checkbox"
                              aria-label={intl.formatMessage(
                                messages.selectcollectionmovie,
                                { title: part.title }
                              )}
                              aria-checked={isSelectedPart(part.id)}
                              aria-disabled={
                                isUpdating ||
                                !unrequestedParts.includes(part.id) ||
                                Boolean(
                                  quota?.movie.limit &&
                                  currentlyRemaining <= 0 &&
                                  !isSelectedPart(part.id)
                                )
                              }
                              onClick={() => togglePart(part.id)}
                              className="flex min-h-11 min-w-11 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 aria-disabled:cursor-default aria-disabled:opacity-50"
                            >
                              <span
                                aria-hidden="true"
                                className={`flex h-5 w-5 items-center justify-center rounded border ${isSelectedPart(part.id) ? 'border-indigo-400 bg-indigo-500 text-white' : 'border-gray-400 bg-gray-800'}`}
                              >
                                {isSelectedPart(part.id) && (
                                  <CheckIcon className="h-4 w-4" />
                                )}
                              </span>
                            </button>
                          </td>
                          <td
                            className={`flex items-center px-1 py-4 text-sm font-medium leading-5 text-gray-100 md:px-6 ${
                              partMedia?.status === MediaStatus.BLOCKLISTED &&
                              'pointer-events-none opacity-50'
                            }`}
                          >
                            <div className="relative hidden h-auto w-10 flex-shrink-0 overflow-hidden rounded-md sm:block">
                              <CachedImage
                                type="tmdb"
                                src={
                                  part.posterPath
                                    ? `https://image.tmdb.org/t/p/w600_and_h900_bestv2${part.posterPath}`
                                    : '/images/seerr_poster_not_found.png'
                                }
                                alt=""
                                sizes="100vw"
                                style={{
                                  width: '100%',
                                  height: 'auto',
                                  objectFit: 'cover',
                                }}
                                width={600}
                                height={900}
                              />
                            </div>
                            <div className="flex min-w-0 flex-col justify-center sm:pl-2">
                              <div className="text-xs font-medium">
                                {part.releaseDate?.slice(0, 4)}
                              </div>
                              <div className="break-words text-sm font-bold sm:text-base">
                                {part.title}
                              </div>
                            </div>
                          </td>
                          <td className="py-4 pr-2 text-sm leading-5 text-gray-200 md:px-6 [&_span]:whitespace-normal">
                            {!partMedia && !partRequest && (
                              <Badge>
                                {intl.formatMessage(
                                  globalMessages.notrequested
                                )}
                              </Badge>
                            )}
                            {!partMedia &&
                              partRequest?.status ===
                                MediaRequestStatus.PENDING && (
                                <Badge badgeType="warning">
                                  {intl.formatMessage(globalMessages.pending)}
                                </Badge>
                              )}
                            {((!partMedia &&
                              partRequest?.status ===
                                MediaRequestStatus.APPROVED) ||
                              partMedia?.[is4k ? 'status4k' : 'status'] ===
                                MediaStatus.PROCESSING) && (
                              <Badge badgeType="primary">
                                {intl.formatMessage(globalMessages.requested)}
                              </Badge>
                            )}
                            {partMedia?.[is4k ? 'status4k' : 'status'] ===
                              MediaStatus.AVAILABLE && (
                              <Badge badgeType="success">
                                {intl.formatMessage(globalMessages.available)}
                              </Badge>
                            )}
                            {partMedia?.status === MediaStatus.BLOCKLISTED && (
                              <Badge badgeType="danger">
                                {intl.formatMessage(globalMessages.blocklisted)}
                              </Badge>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
      {(hasPermission(Permission.REQUEST_ADVANCED) ||
        hasPermission(Permission.MANAGE_REQUESTS)) && (
        <AdvancedRequester
          type="movie"
          is4k={is4k}
          onChange={(overrides) => {
            setRequestOverrides(overrides);
          }}
        />
      )}
    </Modal>
  );
};

export default CollectionRequestModal;
