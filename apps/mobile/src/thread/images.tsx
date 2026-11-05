import type { AssetRef } from "@openorc/protocol";
import { useContext, useEffect, useState } from "react";
import { Image, Keyboard, Pressable, View } from "react-native";
import { assetUri, useLinkRead } from "../client";
import { OLDER_MAC_IMAGE } from "../connection/link-connection";
import { HostContext } from "../connection/host-context";
import { Text } from "../ui/Text";
import { ImageViewer } from "./ImageViewer";

/** The asset an attachment path names on the Mac: its stored file name. */
export const attachmentRef = (path: string): AssetRef => ({ kind: "attachment", name: path.split(/[\\/]/).pop() ?? path });

const IMAGE_PATH = /\.(png|jpe?g|gif|webp|heic|avif)$/i;
export const isImagePath = (path: string) => IMAGE_PATH.test(path);

/** An image the transcript names, fetched from its host once and kept on the phone; `key` names the host and the ref. */
const readAsset = (key: string) => {
  const [host, ref] = JSON.parse(key) as [string | null, AssetRef];
  return assetUri(ref, host);
};

/** Tall screenshots stop at 3:4 and wide ones at 21:9, so one image never fills the screen or shrinks to a strip. */
const ASPECT = { tallest: 3 / 4, widest: 21 / 9 };

/** An image's width over its height once it has loaded, held between the tallest and widest a tile takes. */
function useAspect(uri: string | null): number | null {
  const [aspect, setAspect] = useState<number | null>(null);
  useEffect(() => {
    if (!uri) return;
    let current = true;
    Image.getSize(
      uri,
      (width, height) => current && height > 0 && setAspect(Math.min(ASPECT.widest, Math.max(ASPECT.tallest, width / height))),
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [uri]);
  return aspect;
}

/**
 * An image in the transcript as an r16 tile that opens full screen. `compact` is the prompt's thumbnail size; an
 * agent's image takes the column's width.
 */
export function ImageTile({ asset, label, compact = false }: { asset: AssetRef; label: string; compact?: boolean }) {
  const loaded = useLinkRead(JSON.stringify([useContext(HostContext), asset]), readAsset);
  const [open, setOpen] = useState(false);
  const aspect = useAspect(loaded.state === "ready" ? loaded.value : null);
  // A prompt's thumbnail is a 72 pt square; an agent's image takes the column at its own shape, within reason.
  const size = compact ? { width: 72, height: 72 } : { width: "100%" as const, aspectRatio: aspect ?? 16 / 9 };
  if (loaded.state !== "ready")
    return (
      <View className="items-center justify-center rounded-xl bg-surface-2 px-6" style={size}>
        {loaded.state === "failed" ? <Text className="text-center text-xs text-ink-4">{loaded.reason === OLDER_MAC_IMAGE ? OLDER_MAC_IMAGE : "Image unavailable"}</Text> : null}
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
