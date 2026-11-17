import { initials } from "@openorc/client";
import { Image, View } from "react-native";
import { cn } from "./cn";
import { Text } from "./Text";

/** Each face's size: its box, and the initials' type, which stays put whatever the reader's text size. */
const FACES = {
  sm: { box: "size-3.5", type: { fontSize: 7, lineHeight: 9 } },
  md: { box: "size-5", type: { fontSize: 9, lineHeight: 12 } },
  lg: { box: "size-7", type: { fontSize: 11, lineHeight: 14 } },
} as const;

/** A person's face, as the desktop's: their picture, else their initials on a quiet fill. */
export function PersonFace({ name, image, size }: { name: string; image: string | null; size: keyof typeof FACES }) {
  const face = FACES[size];
  if (image) return <Image source={{ uri: image }} accessibilityIgnoresInvertColors className={cn(face.box, "rounded-full")} />;
  return (
    <View className={cn(face.box, "items-center justify-center rounded-full bg-surface-3")}>
      <Text maxFontSizeMultiplier={1} className="text-ink-2" style={face.type}>
        {initials(name)}
      </Text>
    </View>
  );
}
