type Size = { width: number; height: number };

/**
 * Where a double tap zooms: back out to the content's whole width at its top when it is zoomed in, else in to twice
 * its size around the tapped point, as Photos does. The rect is in the content's own space, as the scroll view zooms
 * to it, and the view's size: the scroll view centers a smaller rect, so a short page would leave its top.
 */
export function doubleTapRect(point: { x: number; y: number }, content: Size, zoomed: boolean, view: Size = content) {
  if (zoomed) return { x: 0, y: 0, width: view.width, height: view.height };
  const width = Math.min(view.width, content.width) / 2;
  const height = Math.min(view.height, content.height) / 2;
  const x = Math.min(Math.max(point.x - width / 2, 0), content.width - width);
  const y = Math.min(Math.max(point.y - height / 2, 0), content.height - height);
  return { x, y, width, height };
}
