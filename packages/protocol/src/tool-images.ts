/**
 * Images in tool output are kept as files once the ledger holds them. Each base64 image gives way to an asset URL
 * and its block keeps its shape otherwise: Claude's `source` becomes `{ type: "asset", media_type, url }`, an MCP
 * image's `data` and an image resource's `blob` become `asset`, and a data URL anywhere else becomes the URL itself.
 */
export interface ToolImage {
  mime: string;
  data: string;
}

/** The only asset URLs a tool image may carry: one file in one run's folder. */
export const TOOL_IMAGE_URL = /^openorc-asset:\/\/tool-images\/([A-Za-z0-9-]+)\/([a-f0-9-]+\.(?:png|jpg|gif|webp))$/;

const IMAGE_MIME = /^image\/(?:png|jpeg|gif|webp)$/;
const DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

type Node = Record<string, unknown>;

/** Stands in for a stored image whose file is gone, so the rest of the result still reads as valid content. */
const UNAVAILABLE: Node = { type: "text", text: "[image unavailable]" };

function record(value: unknown): Node | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Node) : null;
}

function base64Image(mime: unknown, data: unknown): ToolImage | null {
  return typeof mime === "string" && IMAGE_MIME.test(mime) && typeof data === "string" && data.length > 0 ? { mime, data } : null;
}

function asset(value: unknown): string | null {
  return typeof value === "string" && TOOL_IMAGE_URL.test(value) ? value : null;
}

/** Rebuilds only what changed, so an output without images comes back as the same object. */
function walk(value: unknown, swapNode: (node: Node) => Node | null, swapText: (text: string) => string | null): unknown {
  if (typeof value === "string") return swapText(value) ?? value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const swapped = walk(item, swapNode, swapText);
      changed ||= swapped !== item;
      return swapped;
    });
    return changed ? next : value;
  }
  const node = record(value);
  if (!node) return value;
  const swapped = swapNode(node);
  if (swapped) return swapped;
  let changed = false;
  const next: Node = {};
  for (const [key, item] of Object.entries(node)) {
    next[key] = walk(item, swapNode, swapText);
    changed ||= next[key] !== item;
  }
  return changed ? next : value;
}

/** Swaps each base64 image in `output` for the URL `store` returns; an image it returns null for stays inline. */
export function storeToolImages(output: unknown, store: (image: ToolImage) => string | null): unknown {
  if (typeof output !== "object" || output === null) return output;
  return walk(
    output,
    (node) => {
      const source = record(node["source"]);
      if (node["type"] === "image" && source?.["type"] === "base64") {
        const image = base64Image(source["media_type"], source["data"]);
        const url = image && store(image);
        return url ? { ...node, source: { type: "asset", media_type: image.mime, url } } : null;
      }
      if (node["type"] === "image" && !source) {
        const image = base64Image(node["mimeType"], node["data"]);
        const url = image && store(image);
        if (!url) return null;
        const { data: _data, ...rest } = node;
        return { ...rest, asset: url };
      }
      const resource = record(node["resource"]);
      if (node["type"] === "resource" && resource) {
        const image = base64Image(resource["mimeType"], resource["blob"]);
        const url = image && store(image);
        if (!url) return null;
        const { blob: _blob, ...rest } = resource;
        return { ...node, resource: { ...rest, asset: url } };
      }
      return null;
    },
    (text) => {
      const match = DATA_URL.exec(text);
      return match ? store({ mime: match[1]!, data: match[2]! }) : null;
    },
  );
}

/** The reverse, for a reader that needs the bytes themselves. An image whose file is gone becomes a line saying so. */
export function inlineToolImages(output: unknown, load: (url: string) => ToolImage | null): unknown {
  if (typeof output !== "object" || output === null) return output;
  return walk(
    output,
    (node) => {
      const source = record(node["source"]);
      if (node["type"] === "image" && source?.["type"] === "asset") {
        const image = asset(source["url"]) && load(source["url"] as string);
        return image ? { ...node, source: { type: "base64", media_type: image.mime, data: image.data } } : UNAVAILABLE;
      }
      if (node["type"] === "image" && !source && asset(node["asset"])) {
        const image = load(node["asset"] as string);
        if (!image) return UNAVAILABLE;
        const { asset: _asset, ...rest } = node;
        return { ...rest, data: image.data };
      }
      const resource = record(node["resource"]);
      if (node["type"] === "resource" && resource && asset(resource["asset"])) {
        const image = load(resource["asset"] as string);
        if (!image) return UNAVAILABLE;
        const { asset: _asset, ...rest } = resource;
        return { ...node, resource: { ...rest, blob: image.data } };
      }
      return null;
    },
    (text) => {
      const image = asset(text) && load(text);
      return image ? `data:${image.mime};base64,${image.data}` : null;
    },
  );
}
