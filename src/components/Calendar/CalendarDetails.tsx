import { toLocalDate } from '@app/components/Calendar/calendarUtils';
import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import SlideOver from '@app/components/Common/SlideOver';
import ManageSlideOver from '@app/components/ManageSlideOver';
import { useNativeRuntime } from '@app/context/NativeRuntimeContext';
import { Permission, useUser } from '@app/hooks/useUser';
import { ClockIcon, CogIcon, PlayIcon } from '@heroicons/react/24/outline';
import type { CalendarItem } from '@server/interfaces/api/calendarInterfaces';
import { hasServarrMapping } from '@server/lib/servarrMapping';
import type { MovieDetails } from '@server/models/Movie';
import type { TvDetails } from '@server/models/Tv';
import { useEffect, useState, type MouseEvent } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';
import {
  ChangeBadge,
  formatEpisode,
  getDateBadge,
} from './CalendarItemPresentation';
import messages from './calendarMessages';

const CalendarDetails = ({
  item,
  onClose,
}: {
  item: CalendarItem | null;
  onClose: () => void;
}) => {
  const intl = useIntl();
  const { play } = useNativeRuntime();
  const { hasPermission } = useUser();
  const [showManage, setShowManage] = useState(false);
  const parsedTmdbId = item?.detailUrl
    ? Number(item.detailUrl.split('/').filter(Boolean)[1])
    : undefined;
  const tmdbId =
    item?.tmdbId ??
    (parsedTmdbId != null && Number.isFinite(parsedTmdbId)
      ? parsedTmdbId
      : undefined);
  const titleUrl =
    item && tmdbId && hasPermission(Permission.MANAGE_REQUESTS)
      ? `/api/v1/${item.mediaType}/${tmdbId}`
      : null;
  const { data: managedTitle } = useSWR<MovieDetails | TvDetails>(titleUrl);
  const canManage = hasServarrMapping(managedTitle?.mediaInfo);

  useEffect(() => {
    setShowManage(false);
  }, [item?.id]);

  if (!item) return null;
  const episode = formatEpisode(item, intl);
  const manageService = item.mediaType === 'movie' ? 'Radarr' : 'Sonarr';

  return (
    <>
      <SlideOver
        show={!showManage}
        title={item.title}
        subText={[episode, item.subtitle].filter(Boolean).join(' · ')}
        onClose={onClose}
      >
        <div className="space-y-5">
          <div className="flex gap-3">
            {item.posterPath ? (
              <div className="relative h-28 w-20 flex-none overflow-hidden rounded bg-gray-700">
                <CachedImage
                  src={item.posterPath}
                  type="tmdb"
                  alt=""
                  fill
                  sizes="80px"
                  className="object-cover"
                />
              </div>
            ) : null}
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                <Badge badgeType="dark">
                  {getDateBadge(item.dateType, intl)}
                </Badge>
                {item.requestedByCurrentUser ? (
                  <Badge>{intl.formatMessage(messages.requested)}</Badge>
                ) : null}
                {item.available ? (
                  <Badge badgeType="success">
                    {intl.formatMessage(messages.available)}
                  </Badge>
                ) : null}
                <ChangeBadge item={item} />
              </div>
              <p className="text-sm text-gray-300">
                {item.allDay
                  ? intl.formatDate(toLocalDate(item.startsAt, true), {
                      weekday: 'long',
                      month: 'long',
                      day: 'numeric',
                    })
                  : intl.formatDate(toLocalDate(item.startsAt), {
                      weekday: 'long',
                      month: 'long',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
              </p>
              {item.requestedQuality ? (
                <p className="text-xs text-gray-400">
                  {intl.formatMessage(messages.requestedQuality, {
                    quality: item.requestedQuality.toUpperCase(),
                  })}
                </p>
              ) : null}
            </div>
          </div>
          {item.previousStartsAt ? (
            <Alert
              type="info"
              title={
                item.changeKind === 'delayed'
                  ? intl.formatMessage(messages.delayed)
                  : intl.formatMessage(messages.movedEarlier)
              }
            >
              {intl.formatMessage(messages.previousDate, {
                date: intl.formatDate(
                  toLocalDate(item.previousStartsAt, item.allDay),
                  { month: 'short', day: 'numeric', year: 'numeric' }
                ),
              })}
            </Alert>
          ) : null}
          {item.dates?.length ? (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-gray-200">
                {intl.formatMessage(messages.allKnownDates)}
              </h3>
              <ul className="space-y-2">
                {item.dates.map((date) => (
                  <li
                    key={`${date.dateType}-${date.startsAt}`}
                    className="flex items-center justify-between rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm"
                  >
                    <span className="text-gray-300">
                      {getDateBadge(date.dateType, intl)}
                    </span>
                    <span className="text-white">
                      {date.allDay
                        ? intl.formatDate(toLocalDate(date.startsAt, true), {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                          })
                        : intl.formatDate(toLocalDate(date.startsAt), {
                            month: 'short',
                            day: 'numeric',
                            year: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {item.detailUrl ? (
              <Button as="a" href={item.detailUrl} buttonType="primary">
                {intl.formatMessage(
                  item.isNewSeason && !item.requestedByCurrentUser
                    ? messages.requestSeason
                    : messages.details
                )}
              </Button>
            ) : null}
            {item.watchUrl && item.available ? (
              <Button
                as="a"
                href={item.watchUrl}
                buttonType="success"
                onClick={(event: MouseEvent<HTMLAnchorElement>) => {
                  if (
                    item.jellyfinItemId &&
                    play({
                      provider: 'jellyfin',
                      itemId: item.jellyfinItemId,
                      fallbackUrl: item.watchUrl!,
                      label: intl.formatMessage(messages.watch),
                      quality: item.is4k ? '4k' : 'standard',
                    })
                  ) {
                    event.preventDefault();
                  }
                }}
              >
                <PlayIcon className="mr-1 h-4 w-4" />
                {intl.formatMessage(messages.watch)}
              </Button>
            ) : null}
            {canManage && managedTitle ? (
              <Button buttonType="default" onClick={() => setShowManage(true)}>
                <CogIcon className="mr-1 h-4 w-4" />
                {intl.formatMessage(messages.manage, {
                  service: manageService,
                })}
              </Button>
            ) : null}
            {item.sourceUrl ? (
              <Button
                as="a"
                href={item.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ClockIcon className="mr-1 h-4 w-4" />
                {item.source === 'radarr' ? 'Radarr' : 'Sonarr'}
              </Button>
            ) : null}
          </div>
          {!item.dates?.length &&
          !item.detailUrl &&
          !item.watchUrl &&
          !item.sourceUrl &&
          !canManage ? (
            <p className="text-sm text-gray-400">
              {intl.formatMessage(messages.noDetails)}
            </p>
          ) : null}
        </div>
      </SlideOver>
      {showManage && managedTitle && item.mediaType === 'movie' ? (
        <ManageSlideOver
          show
          data={managedTitle as MovieDetails}
          mediaType="movie"
          revalidate={() => {
            if (titleUrl) mutate(titleUrl);
          }}
          onClose={() => setShowManage(false)}
        />
      ) : null}
      {showManage && managedTitle && item.mediaType === 'tv' ? (
        <ManageSlideOver
          show
          data={managedTitle as TvDetails}
          mediaType="tv"
          revalidate={() => {
            if (titleUrl) mutate(titleUrl);
          }}
          onClose={() => setShowManage(false)}
        />
      ) : null}
    </>
  );
};

export default CalendarDetails;
