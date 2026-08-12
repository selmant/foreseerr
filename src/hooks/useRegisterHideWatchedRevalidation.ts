import { registerHideWatchedRevalidator } from '@app/utils/mediaActionInvalidation';
import { useEffect } from 'react';

export function useRegisterHideWatchedRevalidation(
  revalidate?: () => void | Promise<void>,
  enabled = true
) {
  useEffect(() => {
    if (!enabled || !revalidate) {
      return undefined;
    }
    return registerHideWatchedRevalidator(revalidate);
  }, [enabled, revalidate]);
}
