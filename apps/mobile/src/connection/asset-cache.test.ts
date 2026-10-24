import { expect, it, vi } from "vitest";
import { createAssetCache } from "./asset-cache";

/** The cache folder as files written by path. */
const disk = vi.hoisted(() => new Map<string, Uint8Array>());
vi.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string;
    constructor(...parts: (string | Directory)[]) {
      this.uri = parts.map((part) => (typeof part === "string" ? part : part.uri)).join("/");
    }
    get exists() {
      return [...disk.keys()].some((path) => path.startsWith(`${this.uri}/`));
    }
    create() {}
  }
  class File {
    readonly uri: string;
    readonly parentDirectory: Directory;
    constructor(parent: Directory, name: string) {
      this.parentDirectory = parent;
      this.uri = `${parent.uri}/${name}`;
    }
    get exists() {
      return disk.has(this.uri);
    }
    write(bytes: Uint8Array) {
      disk.set(this.uri, bytes);
    }
  }
  return { Directory, File, Paths: { cache: "file:///cache" } };
});

const sha256 = (bytes: Uint8Array) => bytes.slice(0, 4);
const ref = { kind: "attachment", name: "0b9f.png" } as const;

it("keeps an image under its type's extension, so a shared copy is an image to iOS, and reads it from there again", async () => {
  const fetch = vi.fn().mockResolvedValue({ mime: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) });
  const cache = createAssetCache(fetch, sha256);
  const uri = await cache.uri("mac-1", ref);
  expect(uri).toMatch(/^file:\/\/\/cache\/assets\/mac-1\/[0-9a-f]+\.png$/);
  expect(await cache.uri("mac-1", ref)).toBe(uri);
  expect(fetch).toHaveBeenCalledOnce();
});

it("keeps a type it does not know without an extension", async () => {
  const cache = createAssetCache(vi.fn().mockResolvedValue({ mime: "application/octet-stream", bytes: new Uint8Array([1]) }), sha256);
  expect(await cache.uri("mac-2", ref)).toMatch(/\/mac-2\/[0-9a-f]+$/);
});
