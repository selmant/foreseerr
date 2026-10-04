import { useEffect } from 'react';
import { useLocation } from 'react-router';

/** Follow section links after the route and its asynchronously loaded content render. */
export default function useHashNavigation(ready = true) {
  const { hash, pathname, key } = useLocation();
  useEffect(() => {
    if (!hash || !ready) return;
    let id: string;
    try {
      id = decodeURIComponent(hash.slice(1));
    } catch {
      return;
    }

    let observer: MutationObserver | undefined;
    const scrollToSection = () => {
      const section = document.getElementById(id);
      if (!section) return false;
      section.scrollIntoView({ block: 'start' });
      observer?.disconnect();
      return true;
    };
    const frame = requestAnimationFrame(() => {
      if (scrollToSection()) return;
      observer = new MutationObserver(scrollToSection);
      observer.observe(document.body, { childList: true, subtree: true });
    });
    const timeout = window.setTimeout(() => observer?.disconnect(), 10000);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timeout);
      observer?.disconnect();
    };
  }, [hash, pathname, key, ready]);
}
