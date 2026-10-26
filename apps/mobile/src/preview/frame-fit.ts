type Size = { width: number; height: number };

/** A point in a frame's own pixels: the space the Mac maps onto its page. */
export type FramePoint = { x: number; y: number };

/** Where the picture sits in the view at its whole size: across the view's width, or as tall as the view and centered. */
export interface FrameFit {
  left: number;
  width: number;
  height: number;
}

/** To a hundredth, and never -0, which reads as another number to a test and to JSON alike. */
const round = (value: number) => Math.round(value * 100) / 100 || 0;

/**
 * The whole frame in the view at its whole size, so nothing scrolls the picture there and a drag can scroll the page:
 * the view's width at the frame's shape, top-aligned, unless that is taller than the view, then the view's height.
 */
export function fitFrame(view: Size, frame: Size): FrameFit {
  const tall = Math.round((view.width * frame.height) / frame.width);
  if (tall <= view.height) return { left: 0, width: view.width, height: tall };
  const width = Math.round((view.height * frame.width) / frame.height);
  return { left: Math.round((view.width - width) / 2), width, height: view.height };
}

/** A point on the picture (in the zoom view's content, unzoomed) in the frame's pixels; null off the picture. */
export function framePoint(point: { x: number; y: number }, fit: FrameFit, frame: Size): FramePoint | null {
  const x = point.x - fit.left;
  if (x < 0 || x > fit.width || point.y < 0 || point.y > fit.height) return null;
  return { x: round((x * frame.width) / fit.width), y: round((point.y * frame.height) / fit.height) };
}

/** A distance the finger travelled on the picture, in the frame's pixels. */
export function frameDistance(dx: number, dy: number, fit: FrameFit, frame: Size): { dx: number; dy: number } {
  return { dx: round((dx * frame.width) / fit.width), dy: round((dy * frame.height) / fit.height) };
}
