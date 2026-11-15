import type { Space } from "@openorc/protocol";
import { Image, View } from "react-native";
import { OpenOrcMark } from "../ui/OpenOrcMark";
import { useColors } from "../ui/mode";
import { Text } from "../ui/Text";

/**
 * A space's mark, as the Mac's space menu draws it: OpenOrc's cube for Personal; an organization's own picture, else
 * its initial on a plane a quarter rounded.
 */
export function SpaceMark({ space, size }: { space: Space; size: number }) {
  const ink = useColors().ink;
  if (space.kind === "personal") return <OpenOrcMark size={size} color={ink} working={false} />;
  const box = { width: size, height: size, borderRadius: size / 4 };
  // Only a picture the Mac handed over whole: an address would be the server's, which this phone does not reach.
  if (space.logo?.startsWith("data:")) return <Image accessibilityIgnoresInvertColors source={{ uri: space.logo }} style={box} />;
  return (
    <View className="items-center justify-center bg-surface-3" style={box}>
      <Text maxFontSizeMultiplier={1} className="text-ink-2" style={{ fontSize: size / 2, lineHeight: size * 0.6 }}>
        {[...space.name.trim()][0]?.toUpperCase() ?? ""}
      </Text>
    </View>
  );
}
