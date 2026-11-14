import { HOSTED_FILE_CHUNK_BYTES, type HostedFileRef, type RpcParams, type RpcResults } from "@openorc/protocol";
import type { HostedAttachmentSource } from "./hosted-attachment-store";
import { readAsBase64 } from "./file-imports";

type Method = "capture" | "state" | "begin" | "append" | "finish" | "retry" | "remove" | "accepted";
export type HostedAttachmentPort = { [K in Method]: (input: RpcParams<`hostedFiles.${K}`>) => Promise<RpcResults[`hostedFiles.${K}`]> };

/** A lost append answer resumes at the core's durable offset, with one bounded chunk outstanding. */
export async function transferHostedAttachment({
  source,
  port,
  current,
  retry = false,
  encode = readAsBase64,
}: {
  source: HostedAttachmentSource;
  port: HostedAttachmentPort;
  current(): boolean;
  retry?: boolean;
  encode?: (blob: Blob) => Promise<string>;
}): Promise<boolean> {
  const ref: HostedFileRef = { ...source.draft, id: source.file.id };
  if (!current()) return false;
  const input = { ...ref, name: source.file.name, bytes: source.file.bytes, mime: source.file.mime };
  let file = await port.begin(input);
  if (retry && current()) {
    await port.retry(ref);
    file = await port.begin(input);
  }
  if (!current()) return false;
  if (file.state.kind !== "importing") return true;
  if (!source.blob || source.blob.size !== file.bytes) throw new Error("This file's saved bytes are missing. Attach it again.");
  let offset = file.imported;
  while (offset < file.bytes) {
    const bytes = Math.min(HOSTED_FILE_CHUNK_BYTES, file.bytes - offset);
    const data = await encode(source.blob.slice(offset, offset + bytes));
    if (!current()) return false;
    const next = await port.append({ ...ref, offset, data });
    if (!current()) return false;
    if (next.imported < offset + bytes || next.imported > file.bytes) throw new Error("This file's saved bytes don't match. Attach it again.");
    offset = next.imported;
  }
  await port.finish(ref);
  return current();
}
