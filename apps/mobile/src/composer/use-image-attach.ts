import { useState } from "react";
import { ActionSheetIOS } from "react-native";
import { failureMessage } from "../failure";
import { attachImage, pickImages, type ImageSource } from "./attachments";
import type { DraftImage } from "./drafts";

/**
 * Photos for a draft: the person picks from the library or takes one, and each goes to the Mac as it is ready. While
 * any is on its way, `uploading` counts it so the composer can hold the send. `onError` hears why one failed, and null
 * when a new pick clears the last failure.
 */
export function useImageAttach({ onImage, onError }: { onImage: (image: DraftImage) => void; onError: (message: string | null) => void }) {
  const [uploading, setUploading] = useState(0);
  const attach = async (source: ImageSource) => {
    const assets = await pickImages(source);
    if (!assets.length) return;
    setUploading((count) => count + assets.length);
    onError(null);
    await Promise.all(
      assets.map((asset) =>
        attachImage(asset)
          .then(onImage)
          .catch((failure: unknown) => onError(failureMessage(failure)))
          .finally(() => setUploading((count) => count - 1)),
      ),
    );
  };
  return {
    uploading,
    chooseImages: () =>
      ActionSheetIOS.showActionSheetWithOptions({ options: ["Photo Library", "Take Photo", "Cancel"], cancelButtonIndex: 2 }, (index) => {
        if (index === 0) void attach("library");
        if (index === 1) void attach("camera");
      }),
  };
}
