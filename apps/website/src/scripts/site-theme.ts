/** The site's theme lives on <html data-theme>, chosen before the first paint by the inline script in Layout.astro. */
export type SiteTheme = "light" | "dark";

const key = "openorc-site-theme";
const themeColor: Record<SiteTheme, string> = { light: "#f7f7f4", dark: "#151410" };

export function siteTheme(): SiteTheme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/** Applies a theme and remembers it; a saved choice stops following the system. */
export function setSiteTheme(theme: SiteTheme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeColor[theme]);
  try {
    localStorage.setItem(key, theme);
  } catch {
    // Private windows can refuse storage; the choice still holds for this page.
  }
}
