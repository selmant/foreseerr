import { genreColorMap } from '@app/components/Discover/constants';
import type { DiscoverFilterDefaults } from '@server/lib/discover/filterDefaults';
import { useEffect, useState } from 'react';

const TV_GENRE_IDS = new Set(
  [10759, 10762, 10763, 10764, 10765, 10766, 10767, 10768].filter(
    (id) => id in genreColorMap
  )
);

export function splitDiscoverGenres(genre?: string): {
  movie: string;
  tv: string;
} {
  const movie: string[] = [];
  const tv: string[] = [];
  if (!genre) {
    return { movie: '', tv: '' };
  }

  for (const part of genre.split(',')) {
    const id = part.trim();
    if (!id) {
      continue;
    }
    if (TV_GENRE_IDS.has(Number(id))) {
      tv.push(id);
    } else {
      movie.push(id);
    }
  }

  return { movie: movie.join(','), tv: tv.join(',') };
}

export function mergeDiscoverGenres(
  current: string | undefined,
  next: string | undefined
): string | undefined {
  const parts = new Set<string>();
  for (const raw of [current, next]) {
    if (!raw) {
      continue;
    }
    for (const part of raw.split(',')) {
      const id = part.trim();
      if (id) {
        parts.add(id);
      }
    }
  }
  return parts.size ? Array.from(parts).join(',') : undefined;
}

export function useDiscoverFilterDraft(
  data: DiscoverFilterDefaults | undefined
): {
  draft: DiscoverFilterDefaults;
  movieGenres: string;
  tvGenres: string;
  setDraft: React.Dispatch<React.SetStateAction<DiscoverFilterDefaults>>;
  setMovieGenres: React.Dispatch<React.SetStateAction<string>>;
  setTvGenres: React.Dispatch<React.SetStateAction<string>>;
  setBool: (key: keyof DiscoverFilterDefaults, value: boolean) => void;
  setString: (key: keyof DiscoverFilterDefaults, value?: string) => void;
  reset: () => void;
} {
  const [draft, setDraft] = useState<DiscoverFilterDefaults>({});
  const [movieGenres, setMovieGenres] = useState('');
  const [tvGenres, setTvGenres] = useState('');

  useEffect(() => {
    if (!data) {
      return;
    }
    setDraft(data);
    const split = splitDiscoverGenres(data.genre);
    setMovieGenres(split.movie);
    setTvGenres(split.tv);
  }, [data]);

  useEffect(() => {
    const genre = mergeDiscoverGenres(movieGenres, tvGenres);
    setDraft((previous) => {
      if ((previous.genre ?? '') === (genre ?? '')) {
        return previous;
      }
      const next = { ...previous };
      if (genre) {
        next.genre = genre;
      } else {
        delete next.genre;
      }
      return next;
    });
  }, [movieGenres, tvGenres]);

  const setBool = (key: keyof DiscoverFilterDefaults, value: boolean) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
  };

  const setString = (key: keyof DiscoverFilterDefaults, value?: string) => {
    setDraft((previous) => {
      const next = { ...previous };
      if (value == null || value === '') {
        delete next[key];
      } else {
        (next as Record<string, string | boolean>)[key] = value;
      }
      return next;
    });
  };

  const reset = () => {
    setDraft({});
    setMovieGenres('');
    setTvGenres('');
  };

  return {
    draft,
    movieGenres,
    tvGenres,
    setDraft,
    setMovieGenres,
    setTvGenres,
    setBool,
    setString,
    reset,
  };
}
