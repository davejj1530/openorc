/** Pages the app opened in Safari over itself, in order. */
export const opened: string[] = [];
export enum WebBrowserPresentationStyle {
  PAGE_SHEET = "pageSheet",
}
export const openBrowserAsync = (url: string) => Promise.resolve(void opened.push(url));
