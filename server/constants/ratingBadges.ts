/** Sources enabled on detail pages and on focused/hovered posters. */
export interface RatingSourceToggles {
  showTmdb: boolean;
  showImdb: boolean;
  showRt: boolean;
  showRtUser: boolean;
  showMetacritic: boolean;
  showTraktCommunity: boolean;
}

/**
 * Full rating badge settings.
 * `show*` = normal (detail + focused poster).
 * `poster*` = idle poster subset (AND'd with matching `show*`).
 */
export interface RatingBadgeSettings extends RatingSourceToggles {
  posterTmdb: boolean;
  posterImdb: boolean;
  posterRt: boolean;
  posterRtUser: boolean;
  posterMetacritic: boolean;
  posterTraktCommunity: boolean;
}

export const DEFAULT_RATING_SOURCE_TOGGLES: RatingSourceToggles = {
  showTmdb: true,
  showImdb: true,
  showRt: true,
  showRtUser: true,
  showMetacritic: true,
  showTraktCommunity: true,
};

/** Idle poster defaults: a short useful set; user can expand in settings. */
export const DEFAULT_RATING_BADGE_SETTINGS: RatingBadgeSettings = {
  ...DEFAULT_RATING_SOURCE_TOGGLES,
  posterTmdb: true,
  posterImdb: true,
  posterRt: true,
  posterRtUser: false,
  posterMetacritic: false,
  posterTraktCommunity: false,
};

/** Resolve which sources render for idle vs focused poster / detail. */
export function resolveRatingBadgeSettings(
  settings: RatingBadgeSettings,
  mode: 'minimal' | 'normal'
): RatingSourceToggles {
  if (mode === 'normal') {
    return {
      showTmdb: settings.showTmdb,
      showImdb: settings.showImdb,
      showRt: settings.showRt,
      showRtUser: settings.showRtUser,
      showMetacritic: settings.showMetacritic,
      showTraktCommunity: settings.showTraktCommunity,
    };
  }

  return {
    showTmdb: settings.showTmdb && settings.posterTmdb,
    showImdb: settings.showImdb && settings.posterImdb,
    showRt: settings.showRt && settings.posterRt,
    showRtUser: settings.showRtUser && settings.posterRtUser,
    showMetacritic: settings.showMetacritic && settings.posterMetacritic,
    showTraktCommunity:
      settings.showTraktCommunity && settings.posterTraktCommunity,
  };
}
