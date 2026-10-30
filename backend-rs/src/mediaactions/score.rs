//! `score.ts` and the score conversions of `anilistSyncCache.ts`.

/// `Math.round`: halves go up.
#[must_use]
pub fn js_round(n: f64) -> f64 {
    (n + 0.5).floor()
}

/// `ratingStarsToProvider`: UI half-stars (0.5–5) to a 1–10 score.
///
/// # Errors
///
/// Node's message for stars out of range.
pub fn stars_to_provider(stars: f64) -> Result<f64, String> {
    if !(0.5..=5.0).contains(&stars) {
        return Err(String::from("ratingStars must be between 0.5 and 5"));
    }
    Ok(js_round(stars * 2.0).clamp(1.0, 10.0))
}

/// `providerRatingToStars` of a rating that is set.
#[must_use]
pub fn provider_to_stars(rating: f64) -> f64 {
    rating / 2.0
}

/// `scoreRawToProvider`: an `AniList` 100-point score as 1–10.
#[must_use]
pub fn score_raw_to_provider(raw: Option<f64>) -> Option<f64> {
    let raw = raw.filter(|r| *r > 0.0)?;
    Some(js_round(raw / 10.0).clamp(1.0, 10.0))
}

/// `providerRatingToScoreRaw`.
#[must_use]
pub fn provider_to_score_raw(rating: f64) -> f64 {
    js_round(rating * 10.0).clamp(10.0, 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_half_stars_to_trakt() {
        for (stars, score) in [(0.5, 1.0), (1.0, 2.0), (2.5, 5.0), (4.5, 9.0), (5.0, 10.0)] {
            assert_eq!(stars_to_provider(stars), Ok(score), "{stars}");
        }
    }

    #[test]
    fn rejects_out_of_range_stars() {
        for stars in [0.0, 5.5] {
            assert!(
                stars_to_provider(stars).is_err_and(|e| e.starts_with("ratingStars must be")),
                "{stars}"
            );
        }
    }

    #[test]
    fn halves_trakt_ratings() {
        assert_eq!(Some(provider_to_stars(8.0)), Some(4.0), "8");
    }

    #[test]
    fn anilist_scores() {
        assert_eq!(score_raw_to_provider(Some(80.0)), Some(8.0), "80");
        assert_eq!(score_raw_to_provider(Some(85.0)), Some(9.0), "rounds up");
        assert_eq!(score_raw_to_provider(Some(0.0)), None, "unscored");
        assert_eq!(score_raw_to_provider(Some(3.0)), Some(1.0), "at least one");
        assert_eq!(Some(provider_to_score_raw(8.0)), Some(80.0), "back");
    }
}
