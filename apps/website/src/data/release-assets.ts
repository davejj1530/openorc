export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
}

/** Accept only completed uploads hosted under this release in our repository. */
export function releaseAssets(input: unknown, tag: string): ReleaseAsset[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((value: Record<string, unknown> | null) => {
    if (!value || value.state !== "uploaded" || typeof value.name !== "string" || typeof value.browser_download_url !== "string") return [];
    if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size <= 0) return [];
    const expected = `https://github.com/davejj1530/openorc/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(value.name)}`;
    if (value.browser_download_url !== expected) return [];
    return [{ name: value.name, url: expected, size: value.size }];
  });
}
