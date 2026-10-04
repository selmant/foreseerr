import { toLocalDate } from '@app/components/Calendar/calendarUtils';
import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import CachedImage from '@app/components/Common/CachedImage';
import LinkButton from '@app/components/Common/LinkButton';
import SlideOver from '@app/components/Common/SlideOver';
import ManageSlideOver from '@app/components/ManageSlideOver';
import { useNativeRuntime } from '@app/context/NativeRuntimeContext';
import { Permission, useUser } from '@app/hooks/useUser';
import {
  ArrowTopRightOnSquareIcon,
  CogIcon,
  InformationCircleIcon,
  PlayIcon,
} from '@heroicons/react/24/outline';
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
  item: selectedItem,
  onClose,
}: {
  item: CalendarItem | null;
  onClose: () => void;
}) => {
  const intl = useIntl();
  const { play } = useNativeRuntime();
  const { hasPermission } = useUser();
  const [showManage, setShowManage] = useState(false);
  // Keep rendering the last release while the panel slides out.
  const [shownItem, setShownItem] = useState(selectedItem);
  useEffect(() => {
    if (selectedItem) setShownItem(selectedItem);
  }, [selectedItem]);
  const item = selectedItem ?? shownItem;
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
  }, [selectedItem?.id]);

  if (!item) return null;
  const episode = formatEpisode(item, intl);
  const hasActions = Boolean(
    item.detailUrl ||
    (item.watchUrl && item.available) ||
    (canManage && managedTitle) ||
    item.sourceUrl
  );

  return (
    <>
      <SlideOver
        show={!!selectedItem && !showManage}
        title={item.title}
        subText={[episode, item.subtitle].filter(Boolean).join(' · ')}
        onClose={onClose}
        footer={
          hasActions ? (
            <div className="flex flex-wrap gap-2">
              {item.detailUrl ? (
                <LinkButton
                  to={item.detailUrl}
                  buttonType="primary"
                  className="min-h-11"
                >
                  <InformationCircleIcon />
                  <span>
                    {intl.formatMessage(
                      item.isNewSeason && !item.requestedByCurrentUser
                        ? messages.requestSeason
                        : messages.details
                    )}
                  </span>
                </LinkButton>
              ) : null}
              {item.watchUrl && item.available ? (
                <Button
                  as="a"
                  href={item.watchUrl}
                  buttonType="success"
                  className="min-h-11"
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
                  <PlayIcon />
                  <span>{intl.formatMessage(messages.watch)}</span>
                </Button>
              ) : null}
              {canManage && managedTitle ? (
                <Button
                  buttonType="default"
                  className="min-h-11"
                  onClick={() => setShowManage(true)}
                >
                  <CogIcon />
                  <span>{intl.formatMessage(messages.manage)}</span>
                </Button>
              ) : null}
              {item.sourceUrl ? (
                <Button
                  as="a"
                  href={item.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-h-11"
                >
                  <ArrowTopRightOnSquareIcon />
                  <span>
                    {intl.formatMessage(messages.openIn, {
                      service: item.source === 'radarr' ? 'Radarr' : 'Sonarr',
                    })}
                  </span>
                </Button>
              ) : null}
            </div>
          ) : undefined
        }
      >
        <div className="space-y-5">
          <div className="flex gap-3">
            {item.posterPath ? (
              <div className="relative h-28 w-20 flex-none overflow-hidden rounded bg-gray-700">
                <CachedImage
                  src={`https://image.tmdb.org/t/p/w300_and_h450_face${item.posterPath}`}
                  type="tmdb"
                  alt=""
                  fill
                  sizes="80px"
                  className="object-cover"
                />
              </div>
            ) : null}
            <div className="min-w-0 flex-1 space-y-2">
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
                      year: 'numeric',
                    })
                  : intl.formatDate(toLocalDate(item.startsAt), {
                      weekday: 'long',
                      month: 'long',
                      day: 'numeric',
                      year: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
              </p>
              {item.requestedQuality ? (
                <p className="text-xs text-gray-400">
                  {intl.formatMessage(
                    item.requestedQuality === '4k'
                      ? messages.requested4k
                      : messages.requestedStandard
                  )}
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
              <h3 className="mb-2 text-xl font-bold">
                {intl.formatMessage(messages.allKnownDates)}
              </h3>
              <ul className="divide-y divide-gray-700 overflow-hidden rounded-md border border-gray-700 shadow">
                {item.dates.map((date) => (
                  <li
                    key={`${date.dateType}-${date.startsAt}`}
                    className="flex flex-col gap-1 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-3"
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
      {canManage && managedTitle && item.mediaType === 'movie' ? (
        <ManageSlideOver
          show={!!selectedItem && showManage}
          data={managedTitle as MovieDetails}
          mediaType="movie"
          revalidate={() => {
            if (titleUrl) mutate(titleUrl);
          }}
          onClose={() => setShowManage(false)}
        />
      ) : null}
      {canManage && managedTitle && item.mediaType === 'tv' ? (
        <ManageSlideOver
          show={!!selectedItem && showManage}
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
