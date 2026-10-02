import { parseAnibridge, parseFribb, type ParsedDataset } from './parsers';

export interface DatasetDefinition {
  key: string;
  /** Lower answers first; a later dataset only fills what an earlier one lacks. */
  rank: number;
  urls: string[];
  licence: string;
  note?: string;
  parse: (body: string) => ParsedDataset;
}

export const DATASETS: DatasetDefinition[] = [
  {
    key: 'anibridge',
    rank: 1,
    urls: [
      'https://github.com/anibridge/anibridge-mappings/releases/download/v3/mappings.min.json',
    ],
    licence: 'MIT',
    parse: parseAnibridge,
  },
  {
    key: 'fribb',
    rank: 2,
    urls: [
      'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json',
      'https://cdn.jsdelivr.net/gh/Fribb/anime-lists@master/anime-list-full.json',
    ],
    licence: 'none',
    note: 'Fribb/anime-lists publishes no licence. It only fills ids anibridge does not have yet, mostly the current season.',
    parse: parseFribb,
  },
];

export const datasetDefinition = (key: string): DatasetDefinition | undefined =>
  DATASETS.find((dataset) => dataset.key === key);

/**
 * Extra mirrors tried after the upstream URLs, so a homelab copy can be the
 * last resort. Comma-separated template URLs where `{key}` is the dataset key.
 */
export function extraMirrors(key: string): string[] {
  const template = process.env.MAPPING_MIRROR_TEMPLATES;
  if (!template) return [];
  return template
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.replace(/\{key\}/g, key));
}
