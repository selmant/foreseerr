//! `anilistEpisodeProgress.ts`: between TMDB season/episode numbers and
//! an `AniList` entry's progress watermark.

/// `TmdbSeasonCount`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SeasonCount {
    /// `seasonNumber`.
    pub season: i64,
    /// `episodeCount`.
    pub episodes: i64,
}

/// `absoluteEpisodeNumber(seasons, seasonNumber, episodeNumber)`.
#[must_use]
pub fn absolute_episode(seasons: &[SeasonCount], season: i64, episode: i64) -> Option<i64> {
    if season < 1 || episode < 1 {
        return None;
    }
    seasons.iter().find(|s| s.season == season)?;
    let prior: i64 = seasons
        .iter()
        .filter(|s| s.season > 0 && s.season < season)
        .map(|s| s.episodes)
        .sum();
    Some(prior + episode)
}

/// `cap`: a positive episode count.
fn cap(count: Option<f64>) -> Option<f64> {
    count.filter(|c| *c > 0.0)
}

/// `anilistProgressForEpisode(absolute, anilistEpisodeCount, seasonEpisodeNumber)`.
#[must_use]
pub fn progress_for_episode(absolute: i64, count: Option<f64>, season_episode: i64) -> Option<i64> {
    if absolute < 1 {
        return None;
    }
    let as_f64 = crate::jsnum::from_i64;
    match cap(count) {
        None => Some(absolute),
        Some(cap) if as_f64(absolute) <= cap => Some(absolute),
        Some(cap) if season_episode >= 1 && as_f64(season_episode) <= cap => Some(season_episode),
        Some(_) => None,
    }
}

/// `1..=count` (`Array.from({ length }, (_, i) => i + 1)`).
fn first_n(count: f64) -> Vec<f64> {
    let last = crate::jsval::to_i64(count.floor()).unwrap_or(0);
    (1..=last).map(crate::jsnum::from_i64).collect()
}

/// `watchedEpisodeNumbersForSeason(seasons, seasonNumber, progress, anilistEpisodeCount)`.
#[must_use]
pub fn watched_for_season(
    seasons: &[SeasonCount],
    season: i64,
    progress: f64,
    count: Option<f64>,
) -> Vec<f64> {
    if season < 1 || progress <= 0.0 {
        return Vec::new();
    }
    let Some(found) = seasons.iter().find(|s| s.season == season) else {
        return Vec::new();
    };
    if found.episodes < 1 {
        return Vec::new();
    }
    let Some(first) = absolute_episode(seasons, season, 1) else {
        return Vec::new();
    };
    let as_f64 = crate::jsnum::from_i64;
    let first = as_f64(first);
    let episodes = as_f64(found.episodes);
    if let Some(cap) = cap(count).filter(|cap| first > *cap) {
        return first_n(progress.min(episodes).min(cap).max(0.0));
    }
    let last = progress.min(first + episodes - 1.0);
    if last < first {
        return Vec::new();
    }
    first_n(last - first + 1.0)
}

/// `nextAnilistProgress(currentProgress, targetProgress, watched)`.
#[must_use]
pub fn next_progress(current: f64, target: f64, watched: bool) -> Option<f64> {
    if target < 1.0 {
        return None;
    }
    if watched {
        return (target > current).then_some(target);
    }
    (current.to_bits() == target.to_bits() || (current - target).abs() < f64::EPSILON)
        .then_some(target - 1.0)
}

/// `watchedEpisodesFromProgress(progress, seasonEpisodeCount, episodeOffset)`.
#[must_use]
pub fn watched_from_progress(progress: f64, season_episodes: f64, offset: f64) -> Vec<f64> {
    let first = (offset + 1.0).max(1.0);
    let last = season_episodes.min(progress + offset);
    if last < first {
        return Vec::new();
    }
    first_n(last - first + 1.0)
        .into_iter()
        .map(|i| first + i - 1.0)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TWO_SEASONS: [SeasonCount; 3] = [
        SeasonCount {
            season: 0,
            episodes: 4,
        },
        SeasonCount {
            season: 1,
            episodes: 12,
        },
        SeasonCount {
            season: 2,
            episodes: 10,
        },
    ];

    fn range(from: i64, to: i64) -> Vec<f64> {
        (from..=to).map(crate::jsnum::from_i64).collect()
    }

    #[test]
    fn absolute_numbers_ignore_specials() {
        assert_eq!(
            absolute_episode(&TWO_SEASONS, 1, 3),
            Some(3),
            "first season"
        );
        assert_eq!(
            absolute_episode(&TWO_SEASONS, 2, 1),
            Some(13),
            "second season"
        );
        assert_eq!(absolute_episode(&TWO_SEASONS, 0, 1), None, "specials");
    }

    #[test]
    fn shorter_cours_fall_back_to_in_season() {
        assert_eq!(
            progress_for_episode(13, Some(10.0), 1),
            Some(1),
            "in season"
        );
        assert_eq!(progress_for_episode(3, Some(12.0), 3), Some(3), "absolute");
        assert_eq!(progress_for_episode(24, Some(10.0), 14), None, "beyond");
    }

    #[test]
    fn progress_back_to_seasons() {
        assert_eq!(
            watched_for_season(&TWO_SEASONS, 1, 10.0, Some(22.0)),
            range(1, 10),
            "first"
        );
        assert_eq!(
            watched_for_season(&TWO_SEASONS, 2, 15.0, Some(22.0)),
            range(1, 3),
            "second"
        );
        assert_eq!(
            watched_for_season(&TWO_SEASONS, 2, 4.0, Some(10.0)),
            range(1, 4),
            "split"
        );
    }

    #[test]
    fn only_rewinds_from_the_latest() {
        assert_eq!(next_progress(4.0, 10.0, true), Some(10.0), "forward");
        assert_eq!(next_progress(10.0, 10.0, true), None, "already");
        assert_eq!(next_progress(10.0, 10.0, false), Some(9.0), "rewind");
        assert_eq!(next_progress(10.0, 8.0, false), None, "not the latest");
    }

    #[test]
    fn progress_with_offsets() {
        assert_eq!(
            watched_from_progress(10.0, 25.0, 0.0),
            range(1, 10),
            "plain"
        );
        assert_eq!(
            watched_from_progress(5.0, 25.0, 13.0),
            range(14, 18),
            "cour offset"
        );
        assert!(watched_from_progress(0.0, 25.0, 0.0).is_empty(), "none");
        assert_eq!(
            watched_from_progress(30.0, 26.0, -26.0),
            range(1, 4),
            "carries on"
        );
        assert!(
            watched_from_progress(20.0, 26.0, -26.0).is_empty(),
            "not yet"
        );
    }
}
