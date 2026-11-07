export function threadFoldIds(saved: readonly string[]): string[] {
  return [...new Set(saved.filter((key) => /^thread-(open|closed):/.test(key)).map((key) => key.slice(key.indexOf(":") + 1)))];
}

export function pruneThreadFolds(saved: readonly string[], missing: ReadonlySet<string>): string[] {
  return saved.filter((key) => !/^thread-(open|closed):/.test(key) || !missing.has(key.slice(key.indexOf(":") + 1)));
}
