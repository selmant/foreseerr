import { useEffect } from 'react';

let lockCount = 0;
let originalOverflowStyle = '';
let originalTouchActionStyle = '';

/**
 * Hook to lock the body scroll whenever a component is mounted or
 * whenever isLocked is set to true.
 *
 * You can pass in true always to cause a lock on mount/dismount of the component
 * using this hook.
 *
 * @param isLocked Toggle the scroll lock
 * @param disabled Disables the entire hook (allows conditional skipping of the lock)
 */
export const useLockBodyScroll = (
  isLocked: boolean,
  disabled?: boolean
): void => {
  useEffect(() => {
    if (!isLocked || disabled) return;
    if (lockCount === 0) {
      originalOverflowStyle = document.body.style.overflow;
      originalTouchActionStyle = document.body.style.touchAction;
      document.body.style.overflow = 'hidden';
      document.body.style.touchAction = 'none';
    }
    lockCount += 1;
    return () => {
      lockCount -= 1;
      if (lockCount === 0) {
        document.body.style.overflow = originalOverflowStyle;
        document.body.style.touchAction = originalTouchActionStyle;
      }
    };
  }, [isLocked, disabled]);
};
