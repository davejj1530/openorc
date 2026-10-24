import * as WebBrowser from "expo-web-browser";
import { Keyboard } from "react-native";

/**
 * A web page in Safari over the app, as a page sheet, so swiping it away comes back to where the reader was. The
 * keyboard goes first, as it would cover the sheet's foot.
 */
export function openInApp(url: string): void {
  Keyboard.dismiss();
  void WebBrowser.openBrowserAsync(url, { presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET });
}
