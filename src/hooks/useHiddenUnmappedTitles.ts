import { areDiscoverDefaultsCleared } from '@app/components/Discover/mergeFilterDefaults';
import { useDiscoverFilterDefaults } from '@app/hooks/useDiscoverFilterDefaults';
import useRouteQuery from '@app/hooks/useRouteQuery';
import { useUser } from '@app/hooks/useUser';
import type { DiscoverFilterDefaults } from '@server/lib/discover/filterDefaults';
import { useCallback, useEffect, useState } from 'react';

const EVENT = 'seerr-hidden-unmapped-changed';

const storageKey = (userId?: number): string =>
  `seerr-hidden-unmapped:${userId ?? 'anonymous'}`;

export function unmappedHideKey(
  source?: string,
  sourceId?: string,
  ratingKey?: string
): string {
  if (source && sourceId) {
    return `${source}:${sourceId}`;
  }
  return ratingKey ?? '';
}

function readHiddenSet(userId?: number): Set<string> {
  if (typeof window === 'undefined') {
    return new Set();
  }
  try {
    const raw = window.localStorage.getItem(storageKey(userId));
    if (!raw) {
      return new Set();
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((value) => typeof value === 'string'));
  } catch {
    return new Set();
  }
}

function writeHiddenSet(userId: number | undefined, keys: Set<string>): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    const values = [...keys];
    if (values.length) {
      window.localStorage.setItem(storageKey(userId), JSON.stringify(values));
    } else {
      window.localStorage.removeItem(storageKey(userId));
    }
    window.dispatchEvent(new Event(EVENT));
  } catch {
    // ignore quota / private mode
  }
}

export function clearHiddenUnmappedTitles(userId?: number): void {
  writeHiddenSet(userId, new Set());
}

export function hiddenUnmappedCount(userId?: number): number {
  return readHiddenSet(userId).size;
}

export function resolveHideUnmapped(
  defaults: DiscoverFilterDefaults | undefined,
  query: { hideUnmapped?: string | string[] | undefined },
  userId?: number
): boolean {
  const raw = Array.isArray(query.hideUnmapped)
    ? query.hideUnmapped[0]
    : query.hideUnmapped;
  if (raw === 'true') {
    return true;
  }
  if (raw === 'false') {
    return false;
  }
  if (areDiscoverDefaultsCleared(userId)) {
    return false;
  }
  return defaults?.hideUnmapped === true;
}

export const useHiddenUnmappedTitles = (): {
  isHidden: (key: string) => boolean;
  hide: (key: string) => void;
  hideAllUnmapped: boolean;
} => {
  const { user } = useUser();
  const query = useRouteQuery();
  const { data: defaults } = useDiscoverFilterDefaults();
  const [hidden, setHidden] = useState(() => readHiddenSet(user?.id));

  useEffect(() => {
    const sync = () => setHidden(readHiddenSet(user?.id));
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, [user?.id]);

  const hide = useCallback(
    (key: string) => {
      if (!key) {
        return;
      }
      const next = new Set(readHiddenSet(user?.id));
      next.add(key);
      writeHiddenSet(user?.id, next);
      setHidden(next);
    },
    [user?.id]
  );

  return {
    isHidden: (key: string) => Boolean(key) && hidden.has(key),
    hide,
    hideAllUnmapped: resolveHideUnmapped(defaults, query, user?.id),
  };
};
