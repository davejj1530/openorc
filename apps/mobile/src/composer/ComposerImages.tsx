import { Image, Pressable, View } from "react-native";
import { X } from "../generated/icons";
import type { DraftImage } from "./drafts";

/** The draft's images as 72 pt thumbnails with a remove pill, and a fill for each still on its way to the Mac. */
export function ComposerImages({ images, uploading, onRemove }: { images: DraftImage[]; uploading: number; onRemove: (path: string) => void }) {
  if (!images.length && !uploading) return null;
  return (
    <View className="flex-row flex-wrap gap-2">
      {images.map((image) => (
        <View key={image.path}>
          <Image source={{ uri: image.preview }} accessibilityLabel="Attached image" className="rounded-lg bg-surface-2" style={{ width: 72, height: 72 }} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Remove image"
            onPress={() => onRemove(image.path)}
            hitSlop={8}
            className="absolute right-1 top-1 size-5.5 items-center justify-center rounded-full bg-accent"
          >
            <X size={12} className="text-accent-fg" />
          </Pressable>
        </View>
      ))}
      {Array.from({ length: uploading }, (_, index) => (
        <View key={`uploading-${index}`} className="rounded-lg bg-surface-2" style={{ width: 72, height: 72 }} />
      ))}
    </View>
  );
}
