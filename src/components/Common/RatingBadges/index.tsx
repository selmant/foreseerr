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
        'flex flex-col items-start',
        compact ? 'gap-1' : 'gap-2',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid="rating-badges"
    >
      {badges.map((badge) => {
        const content = (
          <>
            <BadgeIcon badge={badge} />
            <span className="text-[0.7rem] font-semibold leading-none text-white">
              {badge.value}
            </span>
          </>
        );

        const classes =
          'inline-flex w-full items-center gap-1.5 text-gray-100 transition hover:text-white';

        return (
          <Tooltip key={badge.key} content={badge.title}>
            {badge.href ? (
              <a
                href={badge.href}
                className={classes}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                {content}
              </a>
            ) : (
              <span className={classes}>{content}</span>
            )}
          </Tooltip>
        );
      })}
    </div>
  );

  if (!compact) {
    return list;
  }

  return (
    <div className="pointer-events-auto inline-flex max-w-full flex-col rounded-lg border border-gray-600/70 bg-gray-800/85 px-2 py-1.5 shadow-md backdrop-blur-[2px]">
      {list}
    </div>
  );
};

export default RatingBadges;
