//! `server/lib/mediaActions`: watched and rating actions fanned out to
//! the user's linked Trakt, Jellyfin, `AniList` and Simkl accounts.
//!
//! [`types`] holds the shapes the routes print, [`dispatcher`] the
//! fan-out and aggregation, and one module per provider its reads and
//! writes (title and episode). The per-user Trakt and `AniList` snapshots
//! are [`crate::mappinglayer::synccache`]'s, patched here after a write
//! the way Node's providers patch theirs.

pub mod anilist;
pub mod anilistepisodes;
pub mod anilistmapping;
pub mod anilistprogress;
pub mod dispatcher;
pub mod env;
pub mod jellyfin;
pub mod jellyfincache;
pub mod score;
pub mod simkl;
pub mod simklepisodes;
pub mod trakt;
pub mod types;

pub use env::Env;
