import type { AssetRef } from "@openorc/protocol";
import { useState } from "react";
import { Image, Keyboard, Pressable, View } from "react-native";
import { assetUri, useLinkRead } from "../client";
import { Text } from "../ui/Text";
import { ImageViewer } from "./ImageViewer";

/** The asset an attachment path names on the Mac: its stored file name. */
export const attachmentRef = (path: string): AssetRef => ({ kind: "attachment", name: path.split(/[\\/]/).pop() ?? path });

const IMAGE_PATH = /\.(png|jpe?g|gif|webp|heic|avif)$/i;
export const isImagePath = (path: string) => IMAGE_PATH.test(path);

/** An image the transcript names, fetched from the Mac once and kept on the phone; `key` is its asset ref. */
const readAsset = (key: string) => assetUri(JSON.parse(key) as AssetRef);

/**
 * An image in the transcript as an r16 tile that opens full screen. `compact` is the prompt's thumbnail size; an
 * agent's image takes the column's width.
 */
export function ImageTile({ asset, label, compact = false }: { asset: AssetRef; label: string; compact?: boolean }) {
  const loaded = useLinkRead(JSON.stringify(asset), readAsset);
  const [open, setOpen] = useState(false);
  // A prompt's thumbnail is a 72 pt square; an agent's image takes the column at 16:9.
  const size = compact ? { width: 72, height: 72 } : { width: "100%" as const, aspectRatio: 16 / 9 };
  if (loaded.state !== "ready")
    return (
      <View className="items-center justify-center rounded-xl bg-surface-2" style={size}>
        {loaded.state === "failed" ? <Text className="text-xs text-ink-4">Image unavailable</Text> : null}
      </View>
    );
  return (
    <>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={label}
        onPress={() => {
          Keyboard.dismiss();
          setOpen(true);
        }}
        className="overflow-hidden rounded-xl bg-surface-2"
        style={size}
      >
        <Image source={{ uri: loaded.value }} accessibilityIgnoresInvertColors style={{ width: "100%", height: "100%" }} resizeMode={compact ? "cover" : "contain"} />
      </Pressable>
      {open ? <ImageViewer uri={loaded.value} label={label} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
