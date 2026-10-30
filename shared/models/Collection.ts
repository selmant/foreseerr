import type { MovieResult } from './Search';

export interface Collection {
  id: number;
  name: string;
  overview?: string;
  posterPath?: string;
  backdropPath?: string;
  parts: MovieResult[];
}
