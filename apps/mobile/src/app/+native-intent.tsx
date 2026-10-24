/**
 * Links from outside the app, before the router reads them. Only pairing links come from outside: any other path
 * would open a screen or a sheet with nothing to show, so it lands on Home.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return /^(?:openorc:\/\/)?\/?pair(?:$|[#?/])/.test(path) ? path : "/";
}
