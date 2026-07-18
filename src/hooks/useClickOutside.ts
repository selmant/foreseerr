import { useEffect } from 'react';

/**
 * useClickOutside
 *
 * Simple hook to add an event listener to the body and allow a callback to
 * be triggered when clicking outside of the target ref
 *
 * @param ref Any HTML Element ref
 * @param callback Callback triggered when clicking outside of ref element
 */
const useClickOutside = (
  ref: React.RefObject<HTMLElement | null>,
  callback: (e: MouseEvent) => void
): void => {
  useEffect(() => {
    // Ignore the click that opened the overlay (same task / very next tick).
    const openedAt = performance.now();
    const handleBodyClick = (e: MouseEvent) => {
      if (performance.now() - openedAt < 100) {
        return;
      }
      if (ref.current && !ref.current.contains(e.target as Node)) {
        callback(e);
      }
    };
    document.body.addEventListener('click', handleBodyClick, { capture: true });

    return () => {
      document.body.removeEventListener('click', handleBodyClick);
    };
  }, [ref, callback]);
};

export default useClickOutside;
