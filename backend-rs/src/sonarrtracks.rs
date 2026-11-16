//! The audio and subtitle languages a Sonarr episode file holds, and the
//! per-server rule that requires some of them.
//!
//! Sonarr reads a file's tracks with `MediaInfo` after import. Sonarr 5
//! lists them (`audioStreams`, `subtitleStreams`); Sonarr 4 joins their
//! languages with `/` (`audioLanguages`, `subtitles`). The codes are
//! ISO 639-2, sometimes 639-1, as the file's muxer wrote them.
//!
//! A Sonarr server's settings may require audio and subtitle languages,
//! with an anime override: `requiredAudioLanguages`,
//! `requiredSubtitleLanguages`, `animeRequiredAudioLanguages` and
//! `animeRequiredSubtitleLanguages`. An anime list that is null or empty
//! leaves the standard one in force.

use serde_json::Value;

/// The language codes of a file's tracks, canonical (see [`canonical`]);
/// `und` for a track without one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FileTracks {
    pub audio: Vec<String>,
    pub subtitles: Vec<String>,
}

/// The tracks of an episode file ([`crate::sonarrfiles::file_tracks`]),
/// canonical; none when Sonarr hasn't read the file yet.
#[must_use]
pub fn file_tracks(episode_file: &Value) -> Option<FileTracks> {
    let tracks = crate::sonarrfiles::file_tracks(episode_file)?;
    let side = |key: &str| {
        let mut out: Vec<String> = Vec::new();
        for code in tracks
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(canonical)
        {
            if !out.contains(&code) {
                out.push(code);
            }
        }
        out
    };
    Some(FileTracks {
        audio: side("audioLanguages"),
        subtitles: side("subtitleLanguages"),
    })
}

/// ISO 639-1 codes and 639-2/T variants, as their 639-2/B code.
const ALIASES: &[(&str, &str)] = &[
    ("ar", "ara"),
    ("bg", "bul"),
    ("bn", "ben"),
    ("ca", "cat"),
    ("cs", "cze"),
    ("da", "dan"),
    ("de", "ger"),
    ("el", "gre"),
    ("en", "eng"),
    ("es", "spa"),
    ("et", "est"),
    ("fa", "per"),
    ("fi", "fin"),
    ("fr", "fre"),
    ("he", "heb"),
    ("hi", "hin"),
    ("hr", "hrv"),
    ("hu", "hun"),
    ("id", "ind"),
    ("is", "ice"),
    ("it", "ita"),
    ("ja", "jpn"),
    ("ko", "kor"),
    ("lt", "lit"),
    ("lv", "lav"),
    ("ms", "may"),
    ("nl", "dut"),
    ("no", "nor"),
    ("pl", "pol"),
    ("pt", "por"),
    ("ro", "rum"),
    ("ru", "rus"),
    ("sk", "slo"),
    ("sl", "slv"),
    ("sr", "srp"),
    ("sv", "swe"),
    ("ta", "tam"),
    ("te", "tel"),
    ("th", "tha"),
    ("tl", "tgl"),
    ("tr", "tur"),
    ("uk", "ukr"),
    ("vi", "vie"),
    ("zh", "chi"),
    ("bod", "tib"),
    ("ces", "cze"),
    ("cym", "wel"),
    ("deu", "ger"),
    ("ell", "gre"),
    ("eus", "baq"),
    ("fas", "per"),
    ("fil", "tgl"),
    ("fra", "fre"),
    ("hye", "arm"),
    ("isl", "ice"),
    ("kat", "geo"),
    ("mkd", "mac"),
    ("mri", "mao"),
    ("msa", "may"),
    ("mya", "bur"),
    ("nld", "dut"),
    ("nob", "nor"),
    ("ron", "rum"),
    ("slk", "slo"),
    ("sqi", "alb"),
    ("zho", "chi"),
];

/// A language code lowercased, as its ISO 639-2/B code when it has one
/// (`ja` and `jpn` are both `jpn`, `deu` is `ger`); anything else as it
/// is. Region suffixes (`en-US`) are dropped.
#[must_use]
pub fn canonical(code: &str) -> String {
    let lower = code.trim().to_ascii_lowercase();
    let base = lower.split(['-', '_']).next().unwrap_or("");
    ALIASES
        .iter()
        .find(|(alias, _)| *alias == base)
        .map_or_else(|| base.to_owned(), |(_, b)| (*b).to_owned())
}

/// English names for the messages; the code itself otherwise.
const NAMES: &[(&str, &str)] = &[
    ("ara", "Arabic"),
    ("chi", "Chinese"),
    ("cze", "Czech"),
    ("dan", "Danish"),
    ("dut", "Dutch"),
    ("eng", "English"),
    ("fin", "Finnish"),
    ("fre", "French"),
    ("ger", "German"),
    ("gre", "Greek"),
    ("heb", "Hebrew"),
    ("hin", "Hindi"),
    ("hun", "Hungarian"),
    ("ind", "Indonesian"),
    ("ita", "Italian"),
    ("jpn", "Japanese"),
    ("kor", "Korean"),
    ("may", "Malay"),
    ("nor", "Norwegian"),
    ("pol", "Polish"),
    ("por", "Portuguese"),
    ("rum", "Romanian"),
    ("rus", "Russian"),
    ("spa", "Spanish"),
    ("swe", "Swedish"),
    ("tha", "Thai"),
    ("tur", "Turkish"),
    ("ukr", "Ukrainian"),
    ("vie", "Vietnamese"),
];

/// A canonical code's English name, or the code in capitals.
#[must_use]
pub fn language_name(code: &str) -> String {
    NAMES
        .iter()
        .find(|(c, _)| *c == code)
        .map_or_else(|| code.to_ascii_uppercase(), |(_, n)| (*n).to_owned())
}

/// The languages a file must have, canonical: at least one of each
/// non-empty list.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Rule {
    pub audio: Vec<String>,
    pub subtitles: Vec<String>,
}

impl Rule {
    /// Whether the rule requires anything.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.audio.is_empty() && self.subtitles.is_empty()
    }
}

/// A settings list as canonical codes, duplicates dropped; none when the
/// setting is missing, null or empty.
fn codes_setting(server: &Value, key: &str) -> Option<Vec<String>> {
    let mut out: Vec<String> = Vec::new();
    for code in server
        .get(key)?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
    {
        let code = canonical(code);
        if !code.is_empty() && !out.contains(&code) {
            out.push(code);
        }
    }
    (!out.is_empty()).then_some(out)
}

/// The rule a Sonarr server sets for a series: the anime lists for an
/// anime, where set, else the standard ones.
#[must_use]
pub fn rule_for(server: &Value, anime: bool) -> Rule {
    let pick = |standard: &str, anime_key: &str| {
        anime
            .then(|| codes_setting(server, anime_key))
            .flatten()
            .or_else(|| codes_setting(server, standard))
            .unwrap_or_default()
    };
    Rule {
        audio: pick("requiredAudioLanguages", "animeRequiredAudioLanguages"),
        subtitles: pick(
            "requiredSubtitleLanguages",
            "animeRequiredSubtitleLanguages",
        ),
    }
}

/// Whether any of a Sonarr server's settings require a language.
#[must_use]
pub fn server_has_rule(server: &Value) -> bool {
    !rule_for(server, false).is_empty() || !rule_for(server, true).is_empty()
}

/// What a file lacks: the lists none of its tracks meets.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Missing {
    pub audio: Vec<String>,
    pub subtitles: Vec<String>,
}

/// `required` when no track has any of its languages for certain; empty
/// when one does, or when nothing is required.
///
/// A list is met by any one of its languages. It counts as unmet only when
/// every track names its language: an unnamed (`und`) track could be the
/// one. No tracks at all means none of the languages is there.
fn certainly_missing(required: &[String], tracks: &[String]) -> Vec<String> {
    if required.iter().any(|code| tracks.contains(code)) || tracks.iter().any(|t| t == "und") {
        return Vec::new();
    }
    required.to_vec()
}

/// What `tracks` lacks under `rule`; none when it meets the rule.
#[must_use]
pub fn missing(rule: &Rule, tracks: &FileTracks) -> Option<Missing> {
    // A file Sonarr read no audio from is one it couldn't read at all.
    if tracks.audio.is_empty() {
        return None;
    }
    let audio = certainly_missing(&rule.audio, &tracks.audio);
    let subtitles = certainly_missing(&rule.subtitles, &tracks.subtitles);
    (!audio.is_empty() || !subtitles.is_empty()).then_some(Missing { audio, subtitles })
}

/// A list of codes as names, "none" when empty.
fn names(codes: &[String]) -> String {
    let known: Vec<String> = codes
        .iter()
        .filter(|c| *c != "und")
        .map(|c| language_name(c))
        .fold(Vec::new(), |mut acc, n| {
            if !acc.contains(&n) {
                acc.push(n);
            }
            acc
        });
    if known.is_empty() {
        String::from("none")
    } else {
        known.join(", ")
    }
}

/// The intervention's warning messages: one per missing kind of track.
#[must_use]
pub fn messages(missing: &Missing, tracks: &FileTracks) -> Vec<String> {
    let mut out = Vec::new();
    if !missing.audio.is_empty() {
        out.push(format!(
            "No {} audio (audio: {})",
            names(&missing.audio).replace(", ", " or "),
            names(&tracks.audio)
        ));
    }
    if !missing.subtitles.is_empty() {
        out.push(format!(
            "No {} subtitles (subtitles: {})",
            names(&missing.subtitles).replace(", ", " or "),
            names(&tracks.subtitles)
        ));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tracks(audio: &[&str], subtitles: &[&str]) -> FileTracks {
        FileTracks {
            audio: audio.iter().map(|s| (*s).to_owned()).collect(),
            subtitles: subtitles.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    #[test]
    fn reads_both_sonarr_versions() {
        let v5 = json!({"mediaInfo": {
            "audioStreams": [{"language": "jpn"}, {"language": "en"}],
            "subtitleStreams": [{"language": "eng"}, {"language": ""}]
        }});
        assert_eq!(
            file_tracks(&v5),
            Some(tracks(&["jpn", "eng"], &["eng", "und"]))
        );
        let v4 = json!({"mediaInfo": {"audioLanguages": "jpn/eng", "subtitles": "eng/spa"}});
        assert_eq!(
            file_tracks(&v4),
            Some(tracks(&["jpn", "eng"], &["eng", "spa"]))
        );
        let v4_no_subs = json!({"mediaInfo": {"audioLanguages": "jpn", "subtitles": ""}});
        assert_eq!(file_tracks(&v4_no_subs), Some(tracks(&["jpn"], &[])));
        assert_eq!(
            file_tracks(&json!({"mediaInfo": null})),
            None,
            "not read yet"
        );
        assert_eq!(file_tracks(&json!({})), None);
    }

    #[test]
    fn codes_are_canonical() {
        assert_eq!(canonical("JA"), "jpn");
        assert_eq!(canonical("deu"), "ger");
        assert_eq!(canonical("en-US"), "eng");
        assert_eq!(canonical("jpn"), "jpn");
        assert_eq!(canonical("xyz"), "xyz");
    }

    #[test]
    fn anime_lists_override_the_standard_ones() {
        let server = json!({
            "requiredAudioLanguages": ["eng"],
            "requiredSubtitleLanguages": null,
            "animeRequiredAudioLanguages": ["jpn", "ja"],
            "animeRequiredSubtitleLanguages": ["eng"]
        });
        assert_eq!(
            rule_for(&server, true),
            Rule {
                audio: vec!["jpn".into()],
                subtitles: vec!["eng".into()]
            }
        );
        assert_eq!(
            rule_for(&server, false),
            Rule {
                audio: vec!["eng".into()],
                subtitles: vec![]
            }
        );
        let standard_only =
            json!({"requiredAudioLanguages": ["eng"], "animeRequiredAudioLanguages": []});
        assert_eq!(
            rule_for(&standard_only, true).audio,
            vec![String::from("eng")]
        );
        assert!(server_has_rule(&standard_only));
        assert!(!server_has_rule(&json!({"name": "Sonarr"})));
    }

    #[test]
    fn flags_only_what_is_certainly_missing() {
        let rule = Rule {
            audio: vec!["jpn".into()],
            subtitles: vec!["eng".into()],
        };
        assert_eq!(missing(&rule, &tracks(&["jpn"], &["eng", "spa"])), None);
        assert_eq!(
            missing(&rule, &tracks(&["eng"], &["eng"])),
            Some(Missing {
                audio: vec!["jpn".into()],
                subtitles: vec![]
            }),
            "an English dub"
        );
        assert_eq!(
            missing(&rule, &tracks(&["jpn"], &[])),
            Some(Missing {
                audio: vec![],
                subtitles: vec!["eng".into()]
            }),
            "no subtitles at all"
        );
        assert_eq!(
            missing(&rule, &tracks(&["jpn"], &["und"])),
            None,
            "an unnamed subtitle track could be English"
        );
        assert_eq!(missing(&rule, &tracks(&[], &[])), None, "audio unreadable");
        let either = Rule {
            audio: vec!["eng".into(), "ger".into()],
            subtitles: vec![],
        };
        assert_eq!(
            missing(&either, &tracks(&["ger"], &[])),
            None,
            "one of them is enough"
        );
        assert_eq!(
            missing(&either, &tracks(&["fre"], &[])),
            Some(Missing {
                audio: vec!["eng".into(), "ger".into()],
                subtitles: vec![]
            })
        );
    }

    #[test]
    fn messages_name_what_is_there() {
        let t = tracks(&["eng"], &[]);
        let rule = Rule {
            audio: vec!["jpn".into()],
            subtitles: vec!["eng".into()],
        };
        let m = missing(&rule, &t).unwrap_or_default();
        assert_eq!(
            messages(&m, &t),
            vec![
                String::from("No Japanese audio (audio: English)"),
                String::from("No English subtitles (subtitles: none)"),
            ]
        );
    }
}
