type StackRoute = { key: string; params?: object };

/**
 * A screen's host: its own `host` param, else the nearest one under it in the stack, so a sheet keeps its thread's. A
 * screen being pushed may not be in the stack's state yet; its own params still name its host.
 */
export function screenHost(routes: readonly StackRoute[], route: StackRoute): string | null {
  const own = (route.params as { host?: unknown } | undefined)?.host;
  if (typeof own === "string") return own;
  const index = routes.findIndex((each) => each.key === route.key);
  for (let at = index - 1; at >= 0; at--) {
    const host = (routes[at]?.params as { host?: unknown } | undefined)?.host;
    if (typeof host === "string") return host;
  }
  return null;
}
