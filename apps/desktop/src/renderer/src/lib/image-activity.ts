import type { Block } from "./transcript";

/** Existing ledgers retain the original provider item in detail. */
export function isImageView(block: Block): boolean {
  return block.kind === "activity" && (block.detail as { type?: unknown } | undefined)?.type === "imageView";
}

export function isImageGeneration(block: Block): boolean {
  return block.kind === "activity" && (block.activityKind === "image_generation" || (block.detail as { type?: unknown } | undefined)?.type === "imageGeneration");
}
