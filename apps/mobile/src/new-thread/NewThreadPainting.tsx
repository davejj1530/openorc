import type { Mode } from "@openorc/client/theme";
import { Image, type ImageSourcePropType, View } from "react-native";
import { paintings } from "../generated/tokens";
import { useMode } from "../ui/mode";
import hillPhone from "./pictures/hill-phone.webp";
import hillTall from "./pictures/hill-tall.webp";
import hillWide from "./pictures/hill-wide.webp";
import stormPhone from "./pictures/storm-phone.webp";
import stormTall from "./pictures/storm-tall.webp";
import stormWide from "./pictures/storm-wide.webp";

type Shape = (typeof paintings)[number];
type Size = { width: number; height: number };

/** The storm in dark and the green hill in light, a picture for each shape of card (design-sync dithers them). */
const pictures: Record<Mode, Record<Shape["name"], ImageSourcePropType>> = {
  dark: { phone: stormPhone, wide: stormWide, tall: stormTall },
  light: { phone: hillPhone, wide: hillWide, tall: hillTall },
};

/** How much larger than its own size a picture must be drawn to cover a card; 1 where it covers it as it is. */
const stretch = (shape: Shape, card: Size) => Math.max(1, card.width / shape.width, card.height / shape.height);

/**
 * The picture a card shows and the size it is drawn at: the first that covers the card at its own size, every dot
 * whole. A card larger than them all takes the one that stretches least.
 */
export function paintingFor(card: Size): { name: Shape["name"]; width: number; height: number } {
  const shape = paintings.find((each) => stretch(each, card) === 1) ?? [...paintings].sort((a, b) => stretch(a, card) - stretch(b, card))[0]!;
  const by = stretch(shape, card);
  return { name: shape.name, width: shape.width * by, height: shape.height * by };
}

/**
 * The Mac's painting as New thread's card, filling the box it is given: a window onto the picture, which keeps its
 * top and its middle and never scales, so the keyboard coming up only covers its foot. `card` is the card's size while
 * the keyboard is away, which alone chooses the picture.
 */
export function NewThreadPainting({ card }: { card: Size }) {
  const mode = useMode();
  const { name, width, height } = paintingFor(card);
  return (
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" className="absolute inset-0 items-center overflow-hidden rounded-5xl">
      <Image source={pictures[mode][name]} style={{ width, height }} />
    </View>
  );
}
