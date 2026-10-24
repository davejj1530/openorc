import { generatedImagePath, type Db, type LedgerWriter } from "@openorc/db";
import type { AssetRef } from "@openorc/protocol";
import { profileAssetPath, RASTER_IMAGE_TYPES, readImageFile, type ImageFileRead } from "../services/profile-assets.js";

export interface AssetSources {
  dataDir: string;
  db: Db;
  ledger: LedgerWriter;
}

/** The file an asset reference names. Only a generated image lives outside the profile, at the path its run recorded. */
function assetPath(ref: AssetRef, { dataDir, db, ledger }: AssetSources): string | null {
  switch (ref.kind) {
    case "attachment":
      return profileAssetPath(`openorc-asset://attachments/${ref.name}`, dataDir);
    case "tool-image":
      return profileAssetPath(ref.url, dataDir);
    case "generated":
      // The activity may have arrived in a frame a moment ago and still be queued for the ledger.
      ledger.flush();
      return generatedImagePath(db, ref.runId, ref.activityId);
  }
}

/** A phone's image, by a reference its transcript holds. Raster images only, whatever the desktop shows. */
export async function readRemoteAsset(ref: AssetRef, sources: AssetSources): Promise<ImageFileRead> {
  const file = assetPath(ref, sources);
  return file ? readImageFile(file, RASTER_IMAGE_TYPES) : { ok: false, reason: "missing" };
}
