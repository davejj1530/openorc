import { TOOL_IMAGE_URL } from "@openorc/protocol";
import { urlHost } from "./url-host.js";

/** Presentation only: tool results stay as the ledger holds them, with their images stored as files. */
export type ToolResultMedia = { kind: "image"; src: string | null; label: string } | { kind: "resource"; uri: string; href: string | null; label: string; text?: string };

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// Match the existing image viewer's raster formats and 32 MB file limit.
const maxImageCharacters = Math.ceil((32 * 1024 * 1024) / 3) * 4;
function inlineImage(mimeType: unknown, data: unknown): string | null {
  if (typeof mimeType !== "string" || !/^image\/(png|jpeg|gif|webp|avif)$/i.test(mimeType)) return null;
  if (typeof data !== "string" || !data.length || data.length > maxImageCharacters || !/^[a-z\d+/=\s]+$/i.test(data)) return null;
  return `data:${mimeType};base64,${data}`;
}

/** An image the ledger stored as a file, or the inline base64 a live event still carries. */
function image(mimeType: unknown, data: unknown, asset: unknown): string | null {
  if (typeof asset === "string") return TOOL_IMAGE_URL.test(asset) ? asset : null;
  return inlineImage(mimeType, data);
}

/**
 * Resource URIs can also be opaque MCP identifiers; only web links without credentials are actionable. Parsed by hand
 * because React Native's URL only partly implements its fields.
 */
function webLink(uri: string): string | null {
  const link = uri.trim();
  return /^https?:\/\//i.test(link) && urlHost(link) && !/^[a-z]+:\/\/[^/?#]*@/i.test(link) ? link : null;
}

/** Debug details never expand binary content into megabytes of visible base64. */
export function toolResultDetails(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return (
      JSON.stringify(
        output,
        function (key, value: unknown) {
          if (typeof value === "string" && (key === "blob" || (key === "data" && ["image", "audio", "base64"].includes(this?.type)))) {
            return `[binary data omitted: ${value.length} characters]`;
          }
          return value;
        },
        2,
      ) ?? ""
    );
  } catch {
    return "Result data unavailable";
  }
}

/** A content block's image: MCP uses data/mimeType, Claude's tool_result a base64 source object, stored ones an asset URL. */
function imageBlock(block: Record<string, unknown>): string | null {
  const source = record(block.source);
  if (!source) return image(block.mimeType, block.data, block.asset);
  return source.type === "base64" || source.type === "asset" ? image(source.media_type, source.data, source.url) : null;
}

/** A resource block as media: an image it carries, or a link to what it names. Null when it names nothing. */
function resourceMedia(block: Record<string, unknown>): ToolResultMedia | null {
  const resource = block.type === "resource" ? record(block.resource) : block;
  if (!resource || typeof resource.uri !== "string") return null;
  let label = resource.uri;
  if (typeof resource.title === "string") label = resource.title;
  else if (typeof resource.name === "string") label = resource.name;
  const carriesImage = (typeof resource.blob === "string" || typeof resource.asset === "string") && typeof resource.mimeType === "string" && resource.mimeType.startsWith("image/");
  if (carriesImage) return { kind: "image", src: image(resource.mimeType, resource.blob, resource.asset), label };
  return { kind: "resource", label, uri: resource.uri, href: webLink(resource.uri), ...(typeof resource.text === "string" ? { text: resource.text } : {}) };
}

/** One content item, added to the text or the media it belongs with. Image blocks are numbered as they come. */
function addItem(item: unknown, text: string[], media: ToolResultMedia[], images: { count: number }): void {
  const block = record(item);
  if (typeof item === "string") text.push(item);
  else if (block?.type === "text" && typeof block.text === "string") text.push(block.text);
  else if (block?.type === "image") media.push({ kind: "image", src: imageBlock(block), label: `Tool image ${++images.count}` });
  else if (block && (block.type === "resource" || block.type === "resource_link")) {
    const resource = resourceMedia(block);
    if (resource) media.push(resource);
    else text.push(toolResultDetails(item));
  } else text.push(toolResultDetails(item));
}

/** Understand content types, never vendor-specific JSON fields or URLs buried in text. */
export function toolResult(output: unknown): { text: string; media: ToolResultMedia[]; details: boolean } {
  const envelope = record(output);
  let content: unknown[] | null = null;
  if (Array.isArray(output)) content = output;
  else if (Array.isArray(envelope?.content)) content = envelope.content;
  if (!content) return { text: toolResultDetails(output), media: [], details: false };
  const text: string[] = [];
  const media: ToolResultMedia[] = [];
  const images = { count: 0 };
  for (const item of content) addItem(item, text, media, images);
  // Structured-only and empty results must not disappear either.
  if (!content.length && envelope?.structuredContent !== undefined) text.push(toolResultDetails(envelope.structuredContent));
  return { text: text.join(""), media, details: media.length > 0 || envelope?.structuredContent !== undefined || content.some((item) => record(item)?.type !== "text") };
}
