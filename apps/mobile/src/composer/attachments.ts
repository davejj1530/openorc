import { REMOTE_ATTACHMENT_BYTES, type HostedFileScope } from "@openorc/protocol";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { cloud, link, phoneFile } from "../client";
import { uploadToCloud } from "../cloud/cloud-upload";
import { NO_CLOUD_FILES } from "../cloud/words";
import type { DraftImage } from "./drafts";

/** The longest side an attached image keeps: plenty for an agent to read, a fraction of a camera's full frame. */
const LONGEST_SIDE = 2048;

export type ImageSource = "library" | "camera";

/** Lets the person pick photos or take one. Resolves with nothing when they cancel or refuse access. */
export async function pickImages(source: ImageSource): Promise<ImagePicker.ImagePickerAsset[]> {
  const options: ImagePicker.ImagePickerOptions = { mediaTypes: ["images"], quality: 1, allowsMultipleSelection: source === "library", selectionLimit: 4 };
  if (source === "camera") {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return [];
  }
  const result = source === "camera" ? await ImagePicker.launchCameraAsync(options) : await ImagePicker.launchImageLibraryAsync(options);
  return result.canceled ? [] : result.assets;
}

/**
 * Resizes one picked image on the phone and sends it where its thread lives: to the Mac, which hands back the path a
 * message carries, or with `cloud`, to OpenOrc Cloud through the phone's own session.
 */
export async function attachImage(asset: ImagePicker.ImagePickerAsset, cloudScope: HostedFileScope | null = null): Promise<DraftImage> {
  const context = ImageManipulator.manipulate(asset.uri);
  if (Math.max(asset.width, asset.height) > LONGEST_SIDE) context.resize(asset.width >= asset.height ? { width: LONGEST_SIDE } : { height: LONGEST_SIDE });
  const image = await context.renderAsync();
  const name = `${(asset.fileName ?? "photo").replace(/\.[^.]+$/, "")}.jpg`;
  if (cloudScope) {
    const hosted = cloud.hosted;
    if (!hosted) throw new Error(NO_CLOUD_FILES);
    const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.8 });
    const file = phoneFile(saved.uri);
    try {
      return { path: await uploadToCloud(hosted, cloudScope, { name, source: file.source }), preview: saved.uri };
    } finally {
      file.close();
    }
  }
  const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.8, base64: true });
  const dataBase64 = saved.base64 ?? "";
  if ((dataBase64.length * 3) / 4 > REMOTE_ATTACHMENT_BYTES) throw new Error(`Images sent from a phone must be ${REMOTE_ATTACHMENT_BYTES / 1024 / 1024} MB or smaller.`);
  const { path } = await link.connection.call("attachments.save", { name, mime: "image/jpeg", dataBase64 });
  return { path, preview: saved.uri };
}
