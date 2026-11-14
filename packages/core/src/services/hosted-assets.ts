import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import path from "node:path";
import type { CloudFileReference, CloudFileScope, Hosted } from "@openorc/hosted";
import { HOSTED_FILE_MAX_BYTES } from "./hosted-file-record.js";
import { hostedAssetChunks, hostedDownloadName, hostedThumbnail } from "./hosted-asset-bytes.js";

type Asset = { scope: CloudFileScope; file: CloudFileReference };
type Dependencies = { account(): Hosted | null; chooseDownload?: (name: string) => Promise<string | null> };

/** Original files stream to disk; only checked small thumbnails cross the window RPC boundary. */
export class HostedAssets {
  constructor(private readonly deps: Dependencies) {}

  thumbnail({ scope, file }: Asset): Promise<{ contentType: "image/webp"; data: string }> {
    return this.#files().read(scope, file, true, hostedThumbnail);
  }

  async download({ scope, file }: Asset): Promise<{ saved: boolean }> {
    const files = this.#files();
    if (!this.deps.chooseDownload) throw new Error("Downloads aren't available in this app.");
    await files.capture(scope);
    const target = await this.deps.chooseDownload(hostedDownloadName(file.name));
    if (!target) return { saved: false };
    if (!path.isAbsolute(target)) throw new Error("Choose where to save this file.");
    const temporary = path.join(path.dirname(target), `.openorc-download-${randomUUID()}`);
    try {
      await files.read(scope, file, false, (response) => writeDownload(temporary, response));
      await rename(temporary, target);
      return { saved: true };
    } finally {
      await rm(temporary, { force: true });
    }
  }

  #files(): Hosted["files"] {
    const account = this.deps.account();
    if (!account) throw new Error("Sign in to OpenOrc to open this file.");
    return account.files;
  }
}

async function writeDownload(target: string, response: Response): Promise<void> {
  const expected = response.headers.get("content-length");
  const length = expected === null ? null : Number(expected);
  if (!response.body || (length !== null && (!Number.isSafeInteger(length) || length < 0 || length > HOSTED_FILE_MAX_BYTES))) throw new Error("This file couldn't be downloaded. Try again.");
  const output = await open(target, "wx", 0o600);
  let written = 0;
  try {
    for await (const chunk of hostedAssetChunks(response.body)) {
      written += chunk.byteLength;
      if (written > HOSTED_FILE_MAX_BYTES || (length !== null && written > length)) throw new Error("This file couldn't be downloaded. Try again.");
      await output.writeFile(chunk);
    }
    if (length !== null && written !== length) throw new Error("This file didn't finish downloading. Try again.");
    await output.sync();
  } finally {
    await output.close();
  }
}
