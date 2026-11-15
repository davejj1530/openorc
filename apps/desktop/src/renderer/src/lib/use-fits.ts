import { useLayoutEffect, useRef, useState } from "react";

/**
 * Whether a line of words fits its box alone. The words are measured where they are never seen, so the answer does
 * not depend on which words the box shows now; it is taken again whenever the box, the words or the font changes.
 */
export function useFits<Box extends HTMLElement, Measure extends HTMLElement>(words: string) {
  const box = useRef<Box>(null);
  const measure = useRef<Measure>(null);
  const [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const room = box.current;
    const natural = measure.current;
    if (!room || !natural) return;
    const fit = () => setFits(natural.getBoundingClientRect().width <= room.clientWidth + 0.5);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(room);
    observer.observe(natural);
    void document.fonts?.ready.then(fit);
    return () => observer.disconnect();
  }, [words]);
  return { box, measure, fits };
}
