/** How far down, or how fast, a swipe on an image must go to close the viewer. */
export const DISMISS_DISTANCE = 120;
export const DISMISS_VELOCITY = 900;

/** A swipe down on the image, let go: it closes the viewer, or the image springs back. */
export function swipeCloses(translationY: number, velocityY: number): boolean {
  "worklet";
  return translationY > DISMISS_DISTANCE || (translationY > 24 && velocityY > DISMISS_VELOCITY);
}

/** How dim the ground gets as the image follows the finger down. */
export function groundOpacity(translationY: number, height: number): number {
  "worklet";
  return Math.max(0, 1 - Math.max(0, translationY) / Math.max(1, height * 0.6));
}

/**
 * Where a double tap zooms: back to the whole image when it is zoomed in, else in to twice its size around the tapped
 * point, as Photos does. The rect is in the image's own space, as the scroll view zooms to it.
 */
export function doubleTapRect(point: { x: number; y: number }, size: { width: number; height: number }, zoomed: boolean) {
  if (zoomed) return { x: 0, y: 0, width: size.width, height: size.height };
  const width = size.width / 2;
  const height = size.height / 2;
  const x = Math.min(Math.max(point.x - width / 2, 0), size.width - width);
  const y = Math.min(Math.max(point.y - height / 2, 0), size.height - height);
  return { x, y, width, height };
}
