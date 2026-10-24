import type { AssetRef } from "@openorc/protocol";
import { useState } from "react";
import { Image, Modal, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { assetUri, useLinkRead } from "../client";
import { X } from "../generated/icons";
import { Text } from "../ui/Text";

/** The asset an attachment path names on the Mac: its stored file name. */
export const attachmentRef = (path: string): AssetRef => ({ kind: "attachment", name: path.split(/[\\/]/).pop() ?? path });

const IMAGE_PATH = /\.(png|jpe?g|gif|webp|heic|avif)$/i;
export const isImagePath = (path: string) => IMAGE_PATH.test(path);

/** An image the transcript names, fetched from the Mac once and kept on the phone; `key` is its asset ref. */
const readAsset = (key: string) => assetUri(JSON.parse(key) as AssetRef);

/** Full screen on the tile, pinch or double tap to zoom, tap the cross or swipe the sheet down to leave. */
function Viewer({ uri, label, onClose }: { uri: string; label: string; onClose: () => void }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible animationType="fade" presentationStyle="overFullScreen" transparent onRequestClose={onClose}>
      <View className="flex-1 bg-bg">
        <ScrollView maximumZoomScale={5} minimumZoomScale={1} centerContent showsHorizontalScrollIndicator={false} showsVerticalScrollIndicator={false} bouncesZoom>
          <Image source={{ uri }} accessibilityLabel={label} style={{ width, height }} resizeMode="contain" />
        </ScrollView>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
          className="absolute right-3 size-touch items-center justify-center rounded-full bg-surface active:bg-surface-3"
          style={{ top: insets.top + 8 }}
        >
          <X size={18} />
        </Pressable>
      </View>
    </Modal>
  );
}

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
      <Pressable accessibilityRole="imagebutton" accessibilityLabel={label} onPress={() => setOpen(true)} className="overflow-hidden rounded-xl bg-surface-2" style={size}>
        <Image source={{ uri: loaded.value }} style={{ width: "100%", height: "100%" }} resizeMode={compact ? "cover" : "contain"} />
      </Pressable>
      {open ? <Viewer uri={loaded.value} label={label} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
