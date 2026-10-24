/** Classes resolve to nothing in tests, in the light theme. `themes` records each theme the app set. */
export const themes: string[] = [];
export const useResolveClassNames = () => ({});
export const useUniwind = () => ({ theme: "light" as const });
export const Uniwind = { setTheme: (theme: string) => void themes.push(theme) };
