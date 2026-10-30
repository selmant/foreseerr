//! The part of `server/lib/mapping` the Sonarr send needs: translating
//! requested TMDB seasons to TVDB seasons through the enabled datasets.

use anyhow::Result;

use crate::db::{Bind, Db};

/// `datasetRank(key)`.
fn rank(key: &str) -> i64 {
    crate::mappingdatasets::definition(key).map_or(i64::MAX, |d| d.rank)
}

/// `resolveSonarrSeasons`: each requested season through the best-ranked
/// dataset's `tmdb_show` to `tvdb_show` edges; unmapped seasons pass
/// through; sorted and unique.
///
/// # Errors
///
/// Fails on database errors.
pub async fn sonarr_seasons(db: &Db, tmdb_id: i64, seasons: &[i64]) -> Result<Vec<i64>> {
    let mut out: Vec<i64> = Vec::new();
    for season in seasons {
        let scope = format!("s{season}");
        let rows = db
            .mapping_edges(
                r#"SELECT e."dataset", e."dstScope", e."srcRange", e."dstRange" FROM "mapping_edge" e JOIN "mapping_dataset" d ON d."key" = e."dataset" AND d."generation" = e."generation" AND d."enabled" = ?3 AND d."generation" > 0 WHERE e."srcNs" = 'tmdb_show' AND e."srcId" = ?1 AND e."srcScope" = ?2 AND e."dstNs" = 'tvdb_show' ORDER BY e."id""#,
                &[Bind::Text(tmdb_id.to_string()), Bind::Text(scope), Bind::Bool(true)],
            )
            .await?;
        let rows: Vec<_> = rows
            .into_iter()
            .filter(|r| crate::mappingdatasets::definition(&r.0).is_some())
            .collect();
        let best = rows.iter().map(|r| rank(&r.0)).min();
        let mut mapped = false;
        for (dataset, dst_scope, src_range, dst_range) in &rows {
            if Some(rank(dataset)) != best {
                continue;
            }
            let (Some(src), Some(dst)) = (src_range, dst_range) else {
                continue;
            };
            if crate::mappinglayer::edges::parse_range_pair(src, dst).is_empty() {
                continue;
            }
            if let Some(target) = dst_scope
                .strip_prefix('s')
                .and_then(|n| n.parse::<i64>().ok())
            {
                if !out.contains(&target) {
                    out.push(target);
                }
                mapped = true;
            }
        }
        if !mapped && !out.contains(season) {
            out.push(*season);
        }
    }
    out.sort_unstable();
    Ok(out)
}
