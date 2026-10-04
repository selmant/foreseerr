import { genreColorMap } from '@app/components/Discover/constants';
import type { DiscoverFilterDefaults } from '@server/lib/discover/filterDefaults';
import { useEffect, useRef, useState } from 'react';

export function discoverDefaultsEqual(
  a: DiscoverFilterDefaults,
  b: DiscoverFilterDefaults
): boolean {
  const normalize = (value: DiscoverFilterDefaults) =>
    Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined && entry !== '')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [
          key,
          key === 'genre' && typeof entry === 'string'
            ? [
                ...new Set(
                  entry
                    .split(',')
                    .map((genre) => genre.trim())
                    .filter(Boolean)
                ),
              ]
                .sort()
                .join(',')
            : entry,
        ])
    );
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

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
  data: DiscoverFilterDefaults | undefined,
  userId?: number
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
  discard: () => void;
  hasChanges: boolean;
} {
  const [draft, setDraft] = useState<DiscoverFilterDefaults>({});
  const [movieGenres, setMovieGenres] = useState('');
  const [tvGenres, setTvGenres] = useState('');
  const previousData = useRef<DiscoverFilterDefaults | undefined>(undefined);
  const previousUser = useRef<number | undefined>(undefined);
  const genresInitialized = useRef(false);

  useEffect(() => {
    if (
      !data ||
      (data === previousData.current && userId === previousUser.current)
    ) {
      return;
    }
    const shouldSync =
      userId !== previousUser.current ||
      !previousData.current ||
      discoverDefaultsEqual(draft, previousData.current);
    previousData.current = data;
    previousUser.current = userId;
    if (!shouldSync) return;
    setDraft(data);
    const split = splitDiscoverGenres(data.genre);
    setMovieGenres(split.movie);
    setTvGenres(split.tv);
  }, [data, draft, userId]);

  useEffect(() => {
    if (!genresInitialized.current) {
      genresInitialized.current = true;
      return;
    }
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

  const discard = () => {
    setDraft(data ?? {});
    const split = splitDiscoverGenres(data?.genre);
    setMovieGenres(split.movie);
    setTvGenres(split.tv);
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
    discard,
    hasChanges: !discoverDefaultsEqual(draft, data ?? {}),
  };
}
