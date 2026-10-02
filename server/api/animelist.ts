import { ensureMappingLayer } from '@server/lib/mapping/datasets';
import { edgesFor, targetsIn } from '@server/lib/mapping/edges';
import {
  applyEpisodeRule,
  findEpisodeRules,
} from '@server/lib/mapping/episodes';
import { resolveTmdb } from '@server/lib/mapping/resolve';

export interface AnidbItem {
  tvdbId?: number;
  tmdbId?: number;
  imdbId?: string;
  tvdbSeason?: number;
}

/**
 * AniDB lookups for the library scanners, served from the mapping datasets.
 */
class AnimeListMapping {
  public isLoaded = (): boolean => true;

  public async sync(): Promise<void> {
    await ensureMappingLayer();
  }

  public getFromAnidbId = async (
    anidbId: number
  ): Promise<AnidbItem | undefined> => {
    await ensureMappingLayer();
    const edges = await edgesFor({ ns: 'anidb', id: String(anidbId) });
    if (!edges.length) return undefined;

    const [tvdb] = targetsIn(edges, 'tvdb_show');
    const [tmdb] = [
      ...targetsIn(edges, 'tmdb_show'),
      ...targetsIn(edges, 'tmdb_movie'),
    ];
    const [imdb] = targetsIn(edges, 'imdb');
    const item: AnidbItem = {
      ...(tvdb ? { tvdbId: Number(tvdb.id) } : {}),
      ...(tvdb?.season === undefined ? {} : { tvdbSeason: tvdb.season }),
      ...(tmdb ? { tmdbId: Number(tmdb.id) } : {}),
      ...(imdb ? { imdbId: imdb.id } : {}),
    };
    return Object.keys(item).length ? item : undefined;
  };

  /**
   * What a TVDB "specials" episode actually is.
   *
   * Anime films are routinely parked at season 0 of the parent series, so a
   * Plex specials episode frequently denotes a movie with its own TMDB entry.
   */
  public getSpecialEpisode = async (
    tvdbId: number,
    episode: number
  ): Promise<AnidbItem | undefined> => {
    await ensureMappingLayer();
    const from = { ns: 'tvdb_show' as const, id: String(tvdbId), season: 0 };
    const covers = (
      rules: Awaited<ReturnType<typeof findEpisodeRules>>
    ): string | undefined =>
      rules.find((rule) => applyEpisodeRule(rule, episode) !== undefined)
        ?.target.id;

    const movie = covers(await findEpisodeRules(from, 'tmdb_movie'));
    if (movie) return { tmdbId: Number(movie) };

    const imdbId = covers(await findEpisodeRules(from, 'imdb'));
    if (!imdbId) return undefined;
    const resolution = await resolveTmdb({
      refs: [{ ns: 'imdb', id: imdbId }],
      mediaType: 'movie',
      offline: true,
    });
    return {
      imdbId,
      ...(resolution ? { tmdbId: resolution.tmdbId } : {}),
    };
  };
}

const animeList = new AnimeListMapping();

export default animeList;
