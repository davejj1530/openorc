/** Classes resolve to nothing in tests, in the light theme. `themes` records each theme the app set, `variables` each variable it set per theme. */
export const themes: string[] = [];
export const variables: Record<string, Record<string, string | number>> = {};
export const useResolveClassNames = () => ({});
export const useUniwind = () => ({ theme: "light" as const });
export const Uniwind = {
  setTheme: (theme: string) => void themes.push(theme),
  updateCSSVariables: (theme: string, values: Record<string, string | number>) => void (variables[theme] = { ...variables[theme], ...values }),
};
