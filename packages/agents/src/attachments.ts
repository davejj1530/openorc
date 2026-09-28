/**
 * What the user attached, sorted by what a provider can actually be handed.
 * Pictures go in as picture input where the protocol has a slot for them;
 * everything else is named in the prompt as a path, because every agent we
 * run already has a tool that opens a file it is pointed at.
 */

/** The formats both providers accept as picture input. Not the same set as the app renders. */
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

export function isImageAttachment(path: string): boolean {
  return IMAGE.test(path);
}

export function partitionAttachments(attachments: string[] | undefined): { images: string[]; files: string[] } {
  const images: string[] = [];
  const files: string[] = [];
  for (const path of attachments ?? []) (isImageAttachment(path) ? images : files).push(path);
  return { images, files };
}

/** Names each attached file under the prompt, with the instruction that fits the provider. */
export function withAttachedFiles(prompt: string, files: string[], hint: string): string {
  if (files.length === 0) return prompt;
  return `${prompt}\n\nAttached file${files.length === 1 ? "" : "s"} (${hint}):\n${files.map((file) => `- ${file}`).join("\n")}`;
}
