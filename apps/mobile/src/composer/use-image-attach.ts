import type { HostedFileScope } from "@openorc/protocol";
import { useState } from "react";
import { ActionSheetIOS } from "react-native";
import { useLinkState } from "../client";
import { showsDemo } from "../connection/manager";
import { failureMessage } from "../failure";
import { attachImage, pickImages, type ImageSource } from "./attachments";
import type { DraftImage } from "./drafts";

/**
 * Photos for a draft: the person picks from the library or takes one, and each goes to the Mac as it is ready, or
 * for a thread on OpenOrc Cloud, there. While
 * any is on its way, `uploading` counts it so the composer can hold the send. `onError` hears why one failed, and null
 * when a new pick clears the last failure. The demo opens the library at once: it needs no permission, and the demo
 * asks iOS for none.
 */
export function useImageAttach({
  onImage,
  onError,
  cloud = null,
}: {
  onImage: (image: DraftImage) => void;
  onError: (message: string | null) => void;
  /** Where in OpenOrc Cloud they go, for a cloud thread or a new one there; null: to the Mac. */
  cloud?: HostedFileScope | null;
}) {
  const [uploading, setUploading] = useState(0);
  const demo = showsDemo(useLinkState());
  const attach = async (source: ImageSource) => {
    const assets = await pickImages(source);
    if (!assets.length) return;
    setUploading((count) => count + assets.length);
    onError(null);
    await Promise.all(
      assets.map((asset) =>
        attachImage(asset, cloud)
          .then(onImage)
          .catch((failure: unknown) => onError(failureMessage(failure)))
          .finally(() => setUploading((count) => count - 1)),
      ),
    );
  };
  return {
    uploading,
    chooseImages: () => {
      if (demo) return void attach("library");
      ActionSheetIOS.showActionSheetWithOptions({ options: ["Photo Library", "Take Photo", "Cancel"], cancelButtonIndex: 2 }, (index) => {
        if (index === 0) void attach("library");
        if (index === 1) void attach("camera");
      });
    },
  };
}
