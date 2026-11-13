import { ORCLING_ACCESSORIES, ORCLING_BODY_COLORS, ORCLING_EYE_COLORS, ORCLING_EYES, ORCLING_GLASSES, ORCLING_SHAPES, ORCLING_TEXTURES } from "@openorc/client";
import type { OrclingLook, OrclingLookPart } from "@openorc/protocol";
import { Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { cn } from "../ui/cn";
import { haptic } from "../ui/haptics";
import { Text } from "../ui/Text";
import { OrclingFace } from "./OrclingFace";

const PARTS: readonly { part: OrclingLookPart; label: string; options: readonly { name: string }[] }[] = [
  { part: "shape", label: "Shape", options: ORCLING_SHAPES },
  { part: "eyes", label: "Eyes", options: ORCLING_EYES },
  { part: "texture", label: "Texture", options: ORCLING_TEXTURES },
  { part: "glasses", label: "Glasses", options: ORCLING_GLASSES },
  { part: "accessory", label: "Accessories", options: ORCLING_ACCESSORIES },
];

const COLUMNS = 3;
const GAP = 12;
export const PADDING = 20;

/** The part being changed, as text tabs at their own widths, scrolling sideways where they run out of room. */
export function PartTabs({ part, onPick }: { part: OrclingLookPart; onPick: (part: OrclingLookPart) => void }) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} className="grow-0" contentContainerStyle={{ paddingHorizontal: PADDING }}>
      <View accessibilityRole="tablist" accessibilityLabel="Part to change" className="flex-row gap-1.5">
        {PARTS.map((entry) => {
          const on = entry.part === part;
          return (
            <Pressable
              key={entry.part}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              onPress={() => {
                if (on) return;
                haptic.select();
                onPick(entry.part);
              }}
              className={cn("h-touch justify-center rounded-full px-4", on ? "bg-ink" : "bg-surface-2 active:bg-surface-3")}
            >
              <Text className={cn("text-md", on ? "text-bg" : "text-ink-3")}>{entry.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

/** Each choice for one part, drawn on this Orcling as it would look with it. */
export function Options({ look, part, onChange }: { look: OrclingLook; part: OrclingLookPart; onChange: (look: OrclingLook) => void }) {
  const tile = Math.floor((useWindowDimensions().width - PADDING * 2 - GAP * (COLUMNS - 1)) / COLUMNS);
  const current = PARTS.find((entry) => entry.part === part)!;
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={current.label} className="flex-row flex-wrap" style={{ gap: GAP }}>
      {current.options.map((option, index) => {
        const on = look[part] === index;
        return (
          <Pressable
            key={option.name}
            accessibilityRole="radio"
            accessibilityLabel={option.name}
            accessibilityState={{ checked: on }}
            onPress={() => {
              if (on) return;
              haptic.select();
              onChange({ ...look, [part]: index });
            }}
            style={{ width: tile }}
            className={cn("items-center gap-1 rounded-3xl border-2 bg-surface pb-2.5 pt-2 active:bg-surface-2", on ? "border-ink" : "border-transparent")}
          >
            <OrclingFace look={{ ...look, [part]: index }} size={Math.round(tile * 0.62)} />
            <Text numberOfLines={1} className={cn("text-sm", on ? "text-ink" : "text-ink-3")}>
              {option.name}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function Swatches({ label, colors, value, onChange }: { label: string; colors: readonly { name: string; hex: string }[]; value: string; onChange: (hex: string) => void }) {
  return (
    <View className="gap-2.5">
      <Text accessibilityRole="header" className="px-1 text-sm text-ink-4">
        {label}
      </Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={label} className="flex-row flex-wrap gap-1.5">
        {colors.map((color) => {
          const on = value.toLowerCase() === color.hex;
          return (
            <Pressable
              key={color.hex}
              accessibilityRole="radio"
              accessibilityLabel={color.name}
              accessibilityState={{ checked: on }}
              onPress={() => {
                if (on) return;
                haptic.select();
                onChange(color.hex);
              }}
              className={cn("size-touch items-center justify-center rounded-full border-2", on ? "border-ink" : "border-transparent")}
            >
              <View className="size-8 rounded-full border border-line" style={{ backgroundColor: color.hex }} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Its body color, and its eye color while the eyes are the part being changed, as the Mac's designer shows them. */
export function LookColors({ look, part, onChange }: { look: OrclingLook; part: OrclingLookPart; onChange: (look: OrclingLook) => void }) {
  return (
    <>
      <Swatches label="Color" colors={ORCLING_BODY_COLORS} value={look.bodyColor} onChange={(bodyColor) => onChange({ ...look, bodyColor })} />
      {part === "eyes" ? <Swatches label="Eye color" colors={ORCLING_EYE_COLORS} value={look.eyeColor} onChange={(eyeColor) => onChange({ ...look, eyeColor })} /> : null}
    </>
  );
}
