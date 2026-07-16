import RTAudFresh from '@app/assets/rt_aud_fresh.svg';
import RTAudRotten from '@app/assets/rt_aud_rotten.svg';
import RTFresh from '@app/assets/rt_fresh.svg';
import RTRotten from '@app/assets/rt_rotten.svg';
import ImdbLogo from '@app/assets/services/imdb.svg';
import MetacriticLogo from '@app/assets/services/metacritic.svg';
import TraktLogo from '@app/assets/services/trakt.svg';
import TmdbLogo from '@app/assets/tmdb_logo.svg';
import Tooltip from '@app/components/Common/Tooltip';
import {
  buildRatingBadges,
  type RatingBadge,
  type RatingBadgeItem,
} from '@app/utils/ratingBadges';
import type { RatingBadgeSettings } from '@server/constants/ratingBadges';
import {
  DEFAULT_RATING_BADGE_SETTINGS,
  resolveRatingBadgeSettings,
} from '@server/constants/ratingBadges';

interface RatingBadgesProps {
  item: RatingBadgeItem;
  badgeSettings?: RatingBadgeSettings;
  /** Poster mode: shared panel + logos */
  compact?: boolean;
  /**
   * Focused/hovered poster → normal (all enabled `show*` sources).
   * Idle poster → minimal (`poster*` ∩ `show*`).
   */
  expanded?: boolean;
  className?: string;
}

const BadgeIcon = ({ badge }: { badge: RatingBadge }) => {
  switch (badge.key) {
    case 'tmdb':
      return <TmdbLogo className="h-3 w-auto max-w-[1.75rem]" />;
    case 'imdb':
      return <ImdbLogo className="h-3 w-auto max-w-[1.5rem]" />;
    case 'rt':
      return badge.rtCriticsRating === 'Rotten' ? (
        <RTRotten className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <RTFresh className="h-3.5 w-3.5 shrink-0" />
      );
    case 'rt-user':
      return badge.rtAudienceRating === 'Spilled' ? (
        <RTAudRotten className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <RTAudFresh className="h-3.5 w-3.5 shrink-0" />
      );
    case 'metacritic':
      return <MetacriticLogo className="h-3.5 w-3.5 shrink-0" />;
    case 'trakt-community':
      return <TraktLogo className="h-3.5 w-3.5 shrink-0" />;
    default:
      return null;
  }
};

const RatingBadges = ({
  item,
  badgeSettings = DEFAULT_RATING_BADGE_SETTINGS,
  compact = false,
  expanded = false,
  className = '',
}: RatingBadgesProps) => {
  const activeSettings = resolveRatingBadgeSettings(
    {
      ...DEFAULT_RATING_BADGE_SETTINGS,
      ...badgeSettings,
    },
    expanded || !compact ? 'normal' : 'minimal'
  );
  const badges = buildRatingBadges(item, activeSettings);

  if (!badges.length) {
    return null;
  }

  const list = (
    <div
      className={[
        'flex items-start',
        compact && expanded ? 'grid w-full grid-cols-2 gap-1.5' : 'flex-col',
        compact && !expanded ? 'gap-1' : !compact ? 'gap-2' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid="rating-badges"
    >
      {badges.map((badge) => {
        const content = (
          <>
            <span className="flex min-w-0 items-center gap-1.5">
              <BadgeIcon badge={badge} />
              {compact && expanded && (
                <span className="truncate text-[0.58rem] font-medium uppercase tracking-wide text-gray-300">
                  {badge.label}
                </span>
              )}
            </span>
            <span className="text-[0.7rem] font-bold tabular-nums leading-none text-white">
              {badge.value}
            </span>
          </>
        );

        const classes =
          'inline-flex min-w-0 items-center justify-between gap-1 text-gray-100 transition hover:text-white';

        const itemClasses =
          compact && expanded
            ? 'min-w-0 rounded-md border border-white/10 bg-black/20 px-2 py-1.5 shadow-sm transition hover:border-white/20 hover:bg-black/30'
            : '';

        const item = badge.href ? (
          <a
            href={badge.href}
            className={`${classes} ${itemClasses}`}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={badge.title}
          >
            {content}
          </a>
        ) : (
          <span className={`${classes} ${itemClasses}`} title={badge.title}>
            {content}
          </span>
        );

        return compact && expanded ? (
          <div key={badge.key} className="min-w-0">
            {item}
          </div>
        ) : (
          <Tooltip key={badge.key} content={badge.title}>
            {item}
          </Tooltip>
        );
      })}
    </div>
  );

  if (!compact) {
    return list;
  }

  return (
    <div
      className={`pointer-events-auto inline-flex max-w-full flex-col rounded-lg border px-2 py-1.5 shadow-lg backdrop-blur-md ${
        expanded
          ? 'w-[11rem] border-white/15 bg-gray-950/80'
          : 'border-gray-600/70 bg-gray-800/85'
      }`}
    >
      {expanded && (
        <div className="mb-1.5 flex items-center justify-between border-b border-white/10 pb-1.5">
          <span className="text-[0.58rem] font-semibold uppercase tracking-[0.16em] text-gray-400">
            Ratings
          </span>
          <span className="text-[0.58rem] tabular-nums text-gray-500">
            {badges.length}
          </span>
        </div>
      )}
      {list}
    </div>
  );
};

export default RatingBadges;
