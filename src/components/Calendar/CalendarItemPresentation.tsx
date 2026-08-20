import {
  startOfDay,
  toLocalDate,
} from '@app/components/Calendar/calendarUtils';
import Badge from '@app/components/Common/Badge';
import CachedImage from '@app/components/Common/CachedImage';
import { FilmIcon, TvIcon } from '@heroicons/react/24/outline';
import type {
  CalendarDateType,
  CalendarItem,
} from '@server/interfaces/api/calendarInterfaces';
import type { IntlShape } from 'react-intl';
import { useIntl } from 'react-intl';
import messages from './calendarMessages';

export const formatEpisode = (item: CalendarItem, intl: IntlShape) => {
  if (item.seasonNumber === undefined || item.seasonNumber === null)
    return null;
  if (item.episodeNumber !== undefined && item.episodeNumber !== null) {
    return `S${String(item.seasonNumber).padStart(2, '0')}E${String(item.episodeNumber).padStart(2, '0')}`;
  }
  return `${intl.formatMessage(messages.season)} ${item.seasonNumber}`;
};

export const getDateBadge = (dateType: CalendarDateType, intl: IntlShape) =>
  intl.formatMessage(messages[dateType]);

export const ChangeBadge = ({ item }: { item: CalendarItem }) => {
  const intl = useIntl();
  if (item.isNewSeason)
    return (
      <Badge badgeType="primary">
        {intl.formatMessage(messages.newSeason)}
      </Badge>
    );
  if (item.changeKind === 'announced')
    return (
      <Badge badgeType="primary">
        {intl.formatMessage(messages.announced)}
      </Badge>
    );
  if (item.changeKind === 'delayed')
    return (
      <Badge badgeType="warning">{intl.formatMessage(messages.delayed)}</Badge>
    );
  if (item.changeKind === 'moved_earlier')
    return (
      <Badge badgeType="success">
        {intl.formatMessage(messages.movedEarlier)}
      </Badge>
    );
  if (item.changeKind === 'withdrawn')
    return (
      <Badge badgeType="warning">
        {intl.formatMessage(messages.withdrawn)}
      </Badge>
    );
  return null;
};

export const CalendarChip = ({
  item,
  onClick,
}: {
  item: CalendarItem;
  onClick: () => void;
}) => (
  <button
    onClick={onClick}
    className={`block w-full truncate rounded px-1.5 py-1 text-left text-xs font-medium ${item.available ? 'bg-green-500/20 text-green-200' : item.changeKind === 'delayed' ? 'bg-yellow-500/20 text-yellow-100' : 'bg-indigo-500/20 text-indigo-100'} `}
  >
    {item.mediaType === 'movie' ? '🎬 ' : '📺 '}
    {item.title}
  </button>
);

export const CalendarCard = ({
  item,
  onClick,
}: {
  item: CalendarItem;
  onClick: () => void;
}) => {
  const intl = useIntl();
  const date = toLocalDate(item.startsAt, item.allDay);
  const today = startOfDay(new Date());
  const difference = Math.ceil(
    (startOfDay(date).getTime() - today.getTime()) / 86400000
  );
  const episode = formatEpisode(item, intl);
  return (
    <button
      onClick={onClick}
      className="group flex w-full gap-3 rounded-lg border border-gray-700 bg-gray-800/70 p-3 text-left transition hover:border-gray-500 hover:bg-gray-800"
    >
      <div className="relative h-20 w-14 flex-none overflow-hidden rounded bg-gray-700">
        {item.posterPath ? (
          <CachedImage
            src={item.posterPath}
            type="tmdb"
            alt=""
            fill
            sizes="56px"
            className="object-cover"
          />
        ) : item.mediaType === 'movie' ? (
          <FilmIcon className="m-4 h-6 w-6 text-gray-500" />
        ) : (
          <TvIcon className="m-4 h-6 w-6 text-gray-500" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex gap-2">
          <h3 className="truncate font-semibold text-white group-hover:text-indigo-200">
            {item.title}
          </h3>
          {item.is4k ? <Badge badgeType="light">4K</Badge> : null}
        </div>
        <p className="truncate text-sm text-gray-400">
          {[episode, item.subtitle].filter(Boolean).join(' · ') ||
            (item.mediaType === 'movie'
              ? intl.formatMessage(messages.movies)
              : intl.formatMessage(messages.series))}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Badge badgeType="dark">{getDateBadge(item.dateType, intl)}</Badge>
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
      </div>
      <div className="flex flex-col items-end gap-1 text-right text-xs text-gray-400">
        <span>
          {item.allDay
            ? intl.formatDate(date, { month: 'short', day: 'numeric' })
            : intl.formatTime(date, { hour: 'numeric', minute: '2-digit' })}
        </span>
        {difference >= 0 && difference <= 30 ? (
          <span className="font-medium text-indigo-300">
            {difference === 0
              ? intl.formatMessage(messages.todayCountdown)
              : intl.formatMessage(messages.countdown, { count: difference })}
          </span>
        ) : null}
      </div>
    </button>
  );
};
