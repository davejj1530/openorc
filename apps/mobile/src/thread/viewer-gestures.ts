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
