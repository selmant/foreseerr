import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import Tooltip from '@app/components/Common/Tooltip';
import RequestModal from '@app/components/RequestModal';
import useRequestOverride from '@app/hooks/useRequestOverride';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { episodeRequestSummary } from '@app/utils/episodeRequests';
import {
  CalendarIcon,
  CheckIcon,
  ChevronDownIcon,
  PencilIcon,
  TrashIcon,
  XMarkIcon,
} from '@heroicons/react/24/solid';
import { MediaRequestStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import axios from 'axios';
import { useState } from 'react';
import { useIntl } from 'react-intl';
import { Link } from 'react-router';
import { mutate } from 'swr';

const messages = defineMessages('components.RequestBlock', {
  seasons: '{seasonCount, plural, one {Season} other {Seasons}}',
  episodes: '{episodeCount, plural, one {Episode} other {Episodes}}',
  requestoverrides: 'Request Overrides',
  server: 'Destination Server',
  profilechanged: 'Quality Profile',
  rootfolder: 'Root Folder',
  languageprofile: 'Language Profile',
  requestdate: 'Request Date',
  requestedby: 'Requested By',
  lastmodifiedby: 'Last Modified By',
  approve: 'Approve Request',
  decline: 'Decline Request',
  edit: 'Edit Request',
  delete: 'Delete Request',
  deleteHint: 'Removing this request leaves downloaded files in place.',
  failedmodify: 'Could not update this request. Try again.',
  scope: 'Requested content',
  seasonNumber: 'Season {seasonNumber}',
  viewEpisodes: 'View requested episodes ({count})',
  watchAheadHint:
    'Keeps a buffer of {count} unwatched episodes requested as you watch in Jellyfin.',
});

interface RequestBlockProps {
  request: MediaRequest;
  onUpdate?: () => void;
}

const RequestBlock = ({ request, onUpdate }: RequestBlockProps) => {
  const { user } = useUser();
  const intl = useIntl();
  const { addToast } = useToasts();
  const [isUpdating, setIsUpdating] = useState(false);
  const [showEditModal, setShowEditModal] = useState(false);
  const { profile, rootFolder, server, languageProfile } =
    useRequestOverride(request);

  const runAction = async (action: () => Promise<unknown>) => {
    setIsUpdating(true);
    try {
      await action();
      onUpdate?.();
      void mutate('/api/v1/request/count');
    } catch {
      addToast(intl.formatMessage(messages.failedmodify), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      setIsUpdating(false);
    }
  };
  const updateRequest = (type: 'approve' | 'decline') =>
    runAction(() => axios.post(`/api/v1/request/${request.id}/${type}`));
  const deleteRequest = () =>
    runAction(() => axios.delete(`/api/v1/request/${request.id}`));
  const episodes = [...(request.episodes ?? [])].sort(
    (a, b) =>
      a.seasonNumber - b.seasonNumber || a.episodeNumber - b.episodeNumber
  );
  const status = {
    [MediaRequestStatus.PENDING]: {
      message: globalMessages.pending,
      badgeType: 'warning',
    },
    [MediaRequestStatus.APPROVED]: {
      message: globalMessages.approved,
      badgeType: 'success',
    },
    [MediaRequestStatus.DECLINED]: {
      message: globalMessages.declined,
      badgeType: 'danger',
    },
    [MediaRequestStatus.FAILED]: {
      message: globalMessages.failed,
      badgeType: 'danger',
    },
    [MediaRequestStatus.COMPLETED]: {
      message: globalMessages.completed,
      badgeType: 'success',
    },
  } as const;
  const currentStatus = status[request.status];
  const overrides = [
    { label: messages.server, value: server },
    { label: messages.profilechanged, value: profile },
    { label: messages.rootfolder, value: rootFolder },
    { label: messages.languageprofile, value: languageProfile },
  ].filter((override) => override.value);

  return (
    <div className="block">
      <RequestModal
        show={showEditModal}
        tmdbId={request.media.tmdbId}
        type={request.type}
        is4k={request.is4k}
        editRequest={request}
        onCancel={() => setShowEditModal(false)}
        onComplete={() => {
          if (onUpdate) {
            onUpdate();
          }
          setShowEditModal(false);
        }}
      />
      <div className="space-y-4 px-4 py-4 text-gray-300" aria-busy={isUpdating}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            {request.is4k && <Badge badgeType="warning">4K</Badge>}
            {currentStatus && (
              <Badge badgeType={currentStatus.badgeType}>
                {intl.formatMessage(currentStatus.message)}
              </Badge>
            )}
          </div>
          <Tooltip
            content={intl.formatDate(request.createdAt, {
              dateStyle: 'long',
              timeStyle: 'short',
            })}
          >
            <span className="flex items-center gap-1.5 text-xs text-gray-400">
              <CalendarIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
              {intl.formatDate(request.createdAt, {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </span>
          </Tooltip>
        </div>
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          {[
            { label: messages.requestedby, person: request.requestedBy },
            { label: messages.lastmodifiedby, person: request.modifiedBy },
          ]
            .filter((row) => row.person)
            .map(
              ({ label, person }) =>
                person && (
                  <div key={label.id} className="min-w-0">
                    <dt className="text-xs text-gray-400">
                      {intl.formatMessage(label)}
                    </dt>
                    <dd>
                      <Link
                        to={
                          person.id === user?.id
                            ? '/profile'
                            : `/users/${person.id}`
                        }
                        className="flex min-h-11 items-center gap-2 rounded-md font-medium text-gray-100 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                      >
                        <CachedImage
                          type="avatar"
                          src={person.avatar}
                          alt=""
                          className="h-6 w-6 shrink-0 rounded-full object-cover"
                          width={24}
                          height={24}
                        />
                        <span className="min-w-0 break-words">
                          {person.displayName}
                        </span>
                      </Link>
                    </dd>
                  </div>
                )
            )}
        </dl>
        {request.type === 'tv' &&
          ((request.seasons ?? []).length > 0 ||
            episodes.length > 0 ||
            request.episodeSelectionType === 'watchAhead') && (
            <div className="space-y-2 rounded-lg border border-gray-700 bg-gray-900/30 p-3 text-sm">
              <h4 className="font-medium text-gray-200">
                {intl.formatMessage(messages.scope)}
              </h4>
              {(request.seasons ?? []).length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {[...request.seasons]
                    .sort((a, b) => a.seasonNumber - b.seasonNumber)
                    .map((season) => (
                      <Badge key={season.id}>
                        {season.seasonNumber === 0
                          ? intl.formatMessage(globalMessages.specials)
                          : intl.formatMessage(messages.seasonNumber, {
                              seasonNumber: season.seasonNumber,
                            })}
                      </Badge>
                    ))}
                </div>
              )}
              {(episodes.length > 0 ||
                request.episodeSelectionType === 'watchAhead') && (
                <Badge className="whitespace-normal">
                  {episodeRequestSummary(intl, {
                    episodes,
                    type: request.episodeSelectionType,
                    watchAheadCount: request.watchAheadCount,
                  })}
                </Badge>
              )}
              {request.episodeSelectionType === 'watchAhead' && (
                <p className="text-xs leading-relaxed text-gray-400">
                  {intl.formatMessage(messages.watchAheadHint, {
                    count: request.watchAheadCount ?? 10,
                  })}
                </p>
              )}
              {episodes.length > 0 && (
                <details className="group">
                  <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-2 rounded-md font-medium text-indigo-300 hover:text-indigo-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
                    {intl.formatMessage(messages.viewEpisodes, {
                      count: episodes.length,
                    })}
                    <ChevronDownIcon
                      aria-hidden="true"
                      className="h-5 w-5 shrink-0 transition-transform group-open:rotate-180"
                    />
                  </summary>
                  <ul className="max-h-60 divide-y divide-gray-700 overflow-y-auto">
                    {episodes.map((episode) => (
                      <li
                        key={episode.id}
                        className="py-2 text-xs text-gray-300"
                      >
                        <span className="font-medium text-gray-100">
                          S{String(episode.seasonNumber).padStart(2, '0')}E
                          {String(episode.episodeNumber).padStart(2, '0')}
                        </span>
                        {episode.title && (
                          <span className="ml-1 break-words">
                            — {episode.title}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        {overrides.length > 0 && (
          <div>
            <h4 className="mb-2 text-sm font-medium text-gray-200">
              {intl.formatMessage(messages.requestoverrides)}
            </h4>
            <dl className="divide-y divide-gray-700 rounded-lg bg-gray-900/30 px-3 text-xs">
              {overrides.map(({ label, value }) => (
                <div
                  key={label.id}
                  className="flex flex-wrap justify-between gap-x-3 gap-y-1 py-2"
                >
                  <dt className="font-medium text-gray-400">
                    {intl.formatMessage(label)}
                  </dt>
                  <dd className="min-w-0 break-all text-gray-200">{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {request.status === MediaRequestStatus.PENDING ? (
          <div className="grid grid-cols-2 gap-2">
            <Button
              buttonType="success"
              className="min-h-11"
              onClick={() => void updateRequest('approve')}
              disabled={isUpdating}
            >
              <CheckIcon />
              <span>{intl.formatMessage(globalMessages.approve)}</span>
            </Button>
            <Button
              buttonType="danger"
              className="min-h-11"
              onClick={() => void updateRequest('decline')}
              disabled={isUpdating}
            >
              <XMarkIcon />
              <span>{intl.formatMessage(globalMessages.decline)}</span>
            </Button>
            <Button
              className="col-span-2 min-h-11"
              onClick={() => setShowEditModal(true)}
              disabled={isUpdating}
            >
              <PencilIcon />
              <span>{intl.formatMessage(messages.edit)}</span>
            </Button>
          </div>
        ) : (
          <div>
            <ConfirmButton
              className="min-h-11 w-full"
              onClick={() => void deleteRequest()}
              disabled={isUpdating}
              confirmText={intl.formatMessage(globalMessages.areyousure)}
            >
              <TrashIcon />
              <span>{intl.formatMessage(messages.delete)}</span>
            </ConfirmButton>
            <p className="mt-2 text-xs text-gray-400">
              {intl.formatMessage(messages.deleteHint)}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default RequestBlock;
