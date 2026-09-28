/**
 * Samples renderer responsiveness independently of the display's refresh clock.
 * A 4 ms timer counts gaps over 20 ms, including OS scheduling or renderer work.
 * Only benchmark phases start it; finishing stops the timer.
 */
export function beginMainThreadMeasurement() {
  const startedAt = performance.now();
  let last = startedAt;
  let stallsTotal = 0;
  let longestGapMs = 0;
  let samples = 0;
  const sample = () => {
    const now = performance.now();
    const gap = now - last;
    if (gap > 20) stallsTotal++;
    longestGapMs = Math.max(longestGapMs, gap);
    last = now;
    samples++;
  };
  const timer = setInterval(sample, 4);
  return () => {
    clearInterval(timer);
    sample();
    return { durationMs: last - startedAt, stallsTotal, longestGapMs: Math.round(longestGapMs), samples };
  };
}
