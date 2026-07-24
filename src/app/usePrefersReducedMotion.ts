import { useEffect, useState } from 'react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Tracks the reduced-motion setting so JavaScript-driven animation can stand
 * down. The CSS `prefers-reduced-motion` block only neutralises transitions and
 * keyframes; it cannot reach canvas repaints or inline style updates, so every
 * component that animates from `requestAnimationFrame` has to ask as well.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia(REDUCED_MOTION_QUERY).matches,
  );

  useEffect(() => {
    const media = window.matchMedia(REDUCED_MOTION_QUERY);
    const sync = () => setReduced(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  return reduced;
}
