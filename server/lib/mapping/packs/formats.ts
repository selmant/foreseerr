import type { MappingPackFormat } from '@server/entity/MappingSource';
import {
  isNamespace,
  type IdRef,
  type Namespace,
} from '@server/lib/mapping/types';
import yaml from 'js-yaml';
import { parseStringPromise } from 'xml2js';

/**
 * One parsed pack record: a set of ids naming the same work, plus any episode
 * range translations the source expressed.
 */
export interface PackRecord {
  refs: IdRef[];
  episodeRules?: PackEpisodeRule[];
  title?: string;
  year?: number;
}

export interface PackEpisodeRule {
  source: IdRef;
  target: IdRef;
  sourceRange: string;
  targetRange: string;
  ratio: number;
}

export interface PackParseResult {
  records: PackRecord[];
}

export interface PackParseOptions {
  /** `namespace -> field name` for the flat formats. */
  fieldMap?: Record<string, string>;
  /**
   * `field name -> field naming its media type`, for sources that put movies
   * and shows in one column. Media type is part of an id's identity, so a
   * mistyped id is a wrong poster, not a near miss.
   */
  typeFields?: Record<string, string>;
  /** `pack namespace token -> our namespace`, for graph formats. */
  namespaceMap?: Record<string, Namespace>;
}

const numericOrString = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0)
    return String(value);
  if (typeof value === 'string' && value.trim()) return value.trim();
  return undefined;
};

/**
 * Numeric-only ids. Anime-Lists writes sentinels such as `tvdbid="unknown"` and
 * `tvdbid="hentai"` where a series has no TVDB record.
 */
const numericId = (value: unknown): string | undefined => {
  const raw = numericOrString(value);
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? String(parsed) : undefined;
};

/** anibridge tokens look like `tmdb_show:1429:s1` or `anidb:9541`. */
export function parseGraphToken(
  token: string,
  namespaceMap: Record<string, Namespace> = {}
): IdRef | undefined {
  const parts = token.split(':');
  if (parts.length < 2) return undefined;
  const [rawNamespace, rawId, rawSeason] = parts;
  const mapped = namespaceMap[rawNamespace];
  const ns = mapped ?? (isNamespace(rawNamespace) ? rawNamespace : undefined);
  if (!ns) return undefined;
  // A trailing `:R` marks a release variant rather than a season.
  const seasonMatch = rawSeason?.match(/^s(\d+)$/);
  const id = numericOrString(rawId);
  if (!id) return undefined;
  return {
    ns,
    id,
    ...(seasonMatch ? { season: Number(seasonMatch[1]) } : {}),
  };
}

/**
 * `"1-13"`, `"13-"`, `"5"`, and the ratio form `"14-|2"`. Returns the range
 * string with the ratio split out so the episode engine can apply both.
 */
export const splitRatio = (range: string): { range: string; ratio: number } => {
  const [rangePart, ratioPart] = range.split('|');
  const ratio = Number(ratioPart);
  return {
    range: rangePart.trim(),
    ratio: Number.isFinite(ratio) && ratio > 0 ? ratio : 1,
  };
};

/**
 * anibridge shape: a descriptor token mapping to a set of target tokens, each
 * carrying episode ranges.
 *
 *   "anidb:19242:R": { "tmdb_show:65942:s1": { "1-15": "67-81" } }
 */
function parseJsonGraph(
  body: string,
  options: PackParseOptions
): PackParseResult {
  const parsed: unknown = JSON.parse(body);
  const graph =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? ((parsed as Record<string, unknown>).mappings ?? parsed)
      : undefined;
  if (!graph || typeof graph !== 'object') {
    throw new Error('json-graph pack is not an object');
  }

  const records: PackRecord[] = [];
  for (const [sourceToken, targets] of Object.entries(
    graph as Record<string, unknown>
  )) {
    const source = parseGraphToken(sourceToken, options.namespaceMap);
    if (!source || !targets || typeof targets !== 'object') continue;

    const refs: IdRef[] = [source];
    const episodeRules: PackEpisodeRule[] = [];
    for (const [targetToken, ranges] of Object.entries(
      targets as Record<string, unknown>
    )) {
      const target = parseGraphToken(targetToken, options.namespaceMap);
      if (!target) continue;
      refs.push(target);
      if (!ranges || typeof ranges !== 'object') continue;
      for (const [sourceRange, targetRange] of Object.entries(
        ranges as Record<string, unknown>
      )) {
        if (typeof targetRange !== 'string') continue;
        const { range, ratio } = splitRatio(targetRange);
        episodeRules.push({
          source,
          target,
          sourceRange,
          targetRange: range,
          ratio,
        });
      }
    }
    if (refs.length < 2) continue;
    records.push({
      refs,
      ...(episodeRules.length ? { episodeRules } : {}),
    });
  }
  return { records };
}

/**
 * Flat records with one field per provider, e.g. Fribb and animeApi. Which field
 * feeds which namespace is declared in `fieldMap`, so a new source of this shape
 * needs no code.
 */
const declaredType = (value: unknown): 'movie' | 'tv' | undefined => {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'movie' || normalized === 'movies') return 'movie';
  if (normalized === 'tv' || normalized === 'show' || normalized === 'shows')
    return 'tv';
  return undefined;
};

function recordFromFlatObject(
  entry: Record<string, unknown>,
  fieldMap: Record<string, string>,
  typeFields: Record<string, string> = {}
): PackRecord | undefined {
  const refs: IdRef[] = [];
  for (const [namespace, field] of Object.entries(fieldMap)) {
    if (!isNamespace(namespace)) continue;
    const raw = entry[field];

    // A single column holding both movies and shows: the row's own type field
    // decides the namespace. Guessing here is what produced wrong posters.
    const typeField = typeFields[field];
    if (typeField && (namespace === 'tmdb_show' || namespace === 'tvdb_show')) {
      const type = declaredType(entry[typeField]);
      const id = numericId(Array.isArray(raw) ? raw[0] : raw);
      if (!id || !type) continue;
      const base = namespace === 'tmdb_show' ? 'tmdb' : 'tvdb';
      refs.push({
        ns: (type === 'movie' ? `${base}_movie` : `${base}_show`) as Namespace,
        id,
      });
      continue;
    }

    // Fribb nests TMDB ids as `{ tv, movie }` under one field.
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const nested = raw as Record<string, unknown>;
      const tv = numericId(nested.tv);
      const movie = numericId(
        Array.isArray(nested.movie) ? nested.movie[0] : nested.movie
      );
      if (tv) refs.push({ ns: 'tmdb_show', id: tv });
      if (movie) refs.push({ ns: 'tmdb_movie', id: movie });
      continue;
    }
    const value = Array.isArray(raw) ? raw[0] : raw;
    // Only IMDB and the slug-like namespaces are non-numeric.
    const id =
      namespace === 'imdb' ||
      namespace === 'animeplanet' ||
      namespace === 'trakt'
        ? numericOrString(value)
        : numericId(value);
    if (id) refs.push({ ns: namespace, id });
  }
  if (refs.length < 2) return undefined;
  const title =
    typeof entry.title === 'string'
      ? entry.title
      : typeof entry.title_romaji === 'string'
        ? entry.title_romaji
        : undefined;
  return { refs, ...(title ? { title } : {}) };
}

function parseJsonArray(
  body: string,
  options: PackParseOptions
): PackParseResult {
  const parsed: unknown = JSON.parse(body);
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? Object.values(parsed as Record<string, unknown>)
      : undefined;
  if (!entries) throw new Error('json-array pack is neither array nor object');
  const fieldMap = options.fieldMap ?? {};
  const records: PackRecord[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = recordFromFlatObject(
      entry as Record<string, unknown>,
      fieldMap,
      options.typeFields
    );
    if (record) records.push(record);
  }
  return { records };
}

function parseNdjson(body: string, options: PackParseOptions): PackParseResult {
  const fieldMap = options.fieldMap ?? {};
  const records: PackRecord[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = recordFromFlatObject(
      entry as Record<string, unknown>,
      fieldMap,
      options.typeFields
    );
    if (record) records.push(record);
  }
  if (!records.length) throw new Error('ndjson pack yielded no records');
  return { records };
}

function parseYamlMap(
  body: string,
  options: PackParseOptions
): PackParseResult {
  const parsed = yaml.load(body);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('yaml-map pack is not a mapping');
  }
  return parseJsonArray(JSON.stringify(parsed), options);
}

/**
 * ScudLee/Anime-Lists XML: `<anime anidbid tvdbid defaulttvdbseason>` with
 * optional `<mapping-list>` giving per-season episode ranges.
 */
/** `;1-5;2-6;` inside a `<mapping>` body: AniDB episode to TVDB episode. */
const parseSpecialPairs = (
  text: string
): { anidbEpisode: number; tvdbEpisode: number }[] => {
  const pairs: { anidbEpisode: number; tvdbEpisode: number }[] = [];
  for (const match of text.matchAll(/;(\d+)-(\d+)/g)) {
    pairs.push({
      anidbEpisode: Number(match[1]),
      tvdbEpisode: Number(match[2]),
    });
  }
  return pairs;
};

async function parseXmlAnimeList(body: string): Promise<PackParseResult> {
  const parsed = await parseStringPromise(body, {
    explicitArray: true,
    mergeAttrs: false,
  });
  const list = parsed?.['anime-list']?.anime;
  if (!Array.isArray(list))
    throw new Error('xml-animelist has no <anime> list');

  const records: PackRecord[] = [];
  for (const node of list) {
    const attributes = node?.$ ?? {};
    const anidb = numericId(attributes.anidbid);
    if (!anidb) continue;
    const refs: IdRef[] = [{ ns: 'anidb', id: anidb }];

    const tvdb = numericId(attributes.tvdbid);
    const defaultSeason = Number(attributes.defaulttvdbseason);
    // `defaulttvdbseason="0"` marks a movie or OVA: the TVDB id then names the
    // parent series, not this work, so linking it would merge a film into the
    // show's cluster.
    const isMovie = attributes.defaulttvdbseason === '0';
    if (tvdb && !isMovie) {
      refs.push({
        ns: 'tvdb_show',
        id: tvdb,
        ...(Number.isInteger(defaultSeason) && defaultSeason >= 0
          ? { season: defaultSeason }
          : {}),
      });
    }
    const imdbIds: string[] = (
      typeof attributes.imdbid === 'string' ? attributes.imdbid : ''
    )
      .split(',')
      .map((single: string) => single.trim())
      .filter((single: string) => /^tt\d{4,}$/.test(single));
    for (const single of imdbIds) {
      refs.push({ ns: 'imdb', id: single });
    }
    const tmdb = numericId(attributes.tmdbid);
    if (tmdb) refs.push({ ns: isMovie ? 'tmdb_movie' : 'tmdb_show', id: tmdb });

    if (refs.length < 2) continue;

    const episodeRules: PackEpisodeRule[] = [];
    const mappings = node?.['mapping-list']?.[0]?.mapping;
    if (Array.isArray(mappings) && tvdb) {
      let imdbIndex = 0;
      for (const mapping of mappings) {
        const season = Number(mapping?.$?.tvdbseason);
        const start = Number(mapping?.$?.start);
        const end = Number(mapping?.$?.end);
        const offset = Number(mapping?.$?.offset) || 0;
        const text = typeof mapping?._ === 'string' ? mapping._ : '';

        // Season 0 entries list explicit episode pairs, and each one can be a
        // separate film: this is how a Plex "specials" episode is recognised as a
        // movie rather than an episode.
        if (season === 0 && text) {
          for (const pair of parseSpecialPairs(text)) {
            const movie: IdRef | undefined = imdbIds[imdbIndex]
              ? { ns: 'imdb', id: imdbIds[imdbIndex] }
              : tmdb
                ? { ns: 'tmdb_movie', id: tmdb }
                : undefined;
            if (movie) imdbIndex += 1;
            episodeRules.push({
              source: movie ?? { ns: 'anidb', id: anidb },
              target: { ns: 'tvdb_show', id: tvdb, season: 0 },
              sourceRange: movie ? '1' : String(pair.anidbEpisode),
              targetRange: String(pair.tvdbEpisode),
              ratio: 1,
            });
          }
          continue;
        }

        if (!Number.isInteger(season) || !Number.isInteger(start)) continue;
        const last = Number.isInteger(end) ? end : start;
        episodeRules.push({
          source: { ns: 'anidb', id: anidb },
          target: { ns: 'tvdb_show', id: tvdb, season },
          sourceRange: `${start}-${last}`,
          targetRange: `${start + offset}-${last + offset}`,
          ratio: 1,
        });
      }
    } else if (tvdb && isMovie && (imdbIds.length || tmdb)) {
      // No mapping-list: the films sit at season 0 episodes 1..n in order.
      const sources: IdRef[] = imdbIds.length
        ? imdbIds.map((id: string) => ({ ns: 'imdb' as const, id }))
        : [{ ns: 'tmdb_movie', id: tmdb as string }];
      sources.forEach((source, index) => {
        episodeRules.push({
          source,
          target: { ns: 'tvdb_show', id: tvdb, season: 0 },
          sourceRange: '1',
          targetRange: String(index + 1),
          ratio: 1,
        });
      });
    }

    records.push({
      refs,
      ...(episodeRules.length ? { episodeRules } : {}),
      ...(typeof node?.name?.[0] === 'string' ? { title: node.name[0] } : {}),
    });
  }
  return { records };
}

export async function parsePack(
  format: MappingPackFormat,
  body: string,
  options: PackParseOptions = {}
): Promise<PackParseResult> {
  switch (format) {
    case 'json-graph':
      return parseJsonGraph(body, options);
    case 'json-array':
      return parseJsonArray(body, options);
    case 'ndjson':
      return parseNdjson(body, options);
    case 'yaml-map':
      return parseYamlMap(body, options);
    case 'xml-animelist':
      return parseXmlAnimeList(body);
    default:
      throw new Error(`Unknown mapping pack format "${format}"`);
  }
}

/**
 * Cheap structural check run on a freshly downloaded temp file. A truncated
 * transfer must be rejected before it can replace the live copy.
 */
export function validatePackBody(
  format: MappingPackFormat,
  body: string
): void {
  const trimmed = body.trim();
  if (!trimmed) throw new Error('pack body is empty');
  if (format === 'xml-animelist') {
    if (!trimmed.startsWith('<')) throw new Error('not XML');
    if (!/<\/anime-list>\s*$/.test(trimmed))
      throw new Error('XML is truncated: no closing </anime-list>');
    return;
  }
  if (format === 'ndjson') {
    JSON.parse(trimmed.split('\n')[0]);
    return;
  }
  if (format === 'yaml-map') {
    if (!yaml.load(trimmed)) throw new Error('YAML parsed to nothing');
    return;
  }
  const parsed: unknown = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('JSON pack is not an object or array');
  }
  const size = Array.isArray(parsed)
    ? parsed.length
    : Object.keys(parsed as object).length;
  if (!size) throw new Error('JSON pack contains no entries');
}
