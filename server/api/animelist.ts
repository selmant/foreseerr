import { ensureMappingLayer } from '@server/lib/mapping/bootstrap';
import { findRulesByTarget } from '@server/lib/mapping/episodes';
import { findClusterIds, findLinks } from '@server/lib/mapping/graph';
import mappingService from '@server/lib/mapping/service';
import type { IdRef } from '@server/lib/mapping/types';

export interface AnidbItem {
  tvdbId?: number;
  tmdbId?: number;
  imdbId?: string;
  tvdbSeason?: number;
}

/**
 * Anime-Lists lookups, served from the mapping graph.
 *
 * The bespoke downloader, XML parser, and two in-process indexes this file used
 * to own are gone: Anime-Lists is now one declarative pack (opt-in, since it
 * carries no licence), and its season-0 film mappings are episode rules like any
 * other source's.
 */
class AnimeListMapping {
  public isLoaded = (): boolean => true;

  public sync = async (): Promise<void> => {
    await ensureMappingLayer();
  };

  public getFromAnidbId = async (
    anidbId: number
  ): Promise<AnidbItem | undefined> => {
    const from: IdRef = { ns: 'anidb', id: String(anidbId) };
    const clusterIds = await findClusterIds(from);
    if (!clusterIds.length) return undefined;

    const [tvdbLinks, showLinks, movieLinks, imdbLinks] = await Promise.all([
      findLinks(clusterIds, 'tvdb_show'),
      findLinks(clusterIds, 'tmdb_show'),
      findLinks(clusterIds, 'tmdb_movie'),
      findLinks(clusterIds, 'imdb'),
    ]);

    const tvdb = tvdbLinks[0];
    const tmdb = showLinks[0] ?? movieLinks[0];
    const item: AnidbItem = {
      ...(tvdb ? { tvdbId: Number(tvdb.externalId) } : {}),
      ...(tvdb?.season === undefined ? {} : { tvdbSeason: tvdb.season }),
      ...(tmdb ? { tmdbId: Number(tmdb.externalId) } : {}),
      ...(imdbLinks[0] ? { imdbId: imdbLinks[0].externalId } : {}),
    };
    return Object.keys(item).length ? item : undefined;
  };

  /**
   * What a TVDB "specials" episode actually is.
   *
   * Anime-Lists parks films at season 0 of the parent series, so a Plex specials
   * episode frequently denotes a movie with its own TMDB entry.
   */
  public getSpecialEpisode = async (
    tvdbId: number,
    episode: number
  ): Promise<AnidbItem | undefined> => {
    const rules = await findRulesByTarget(
      { ns: 'tvdb_show', id: String(tvdbId), season: 0 },
      episode
    );
    for (const rule of rules) {
      if (rule.source.ns === 'tmdb_movie') {
        return { tmdbId: Number(rule.source.id) };
      }
      if (rule.source.ns === 'imdb') {
        const resolution = await mappingService.resolve(
          { ns: 'imdb', id: rule.source.id },
          'tmdb_movie',
          { silent: true, offline: true }
        );
        return {
          imdbId: rule.source.id,
          ...(resolution.target?.id
            ? { tmdbId: Number(resolution.target.id) }
            : {}),
        };
      }
    }
    return undefined;
  };
}

const animeList = new AnimeListMapping();

export default animeList;
