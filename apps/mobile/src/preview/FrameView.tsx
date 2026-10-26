import { useLayoutEffect, useRef, useState } from "react";
import { Image, useWindowDimensions, View } from "react-native";
import { cn } from "../ui/cn";
import { ZoomView, type ZoomViewHandle } from "../ui/ZoomView";
import { markFrameShown } from "./preview-perf";
import type { PreviewImage } from "./use-preview";

type Slots = [PreviewImage | null, PreviewImage | null];

interface FrameViewProps {
  /** The newest frame fetched, which comes forward once decoded. */
  frame: PreviewImage;
  /** What VoiceOver reads: the page and the Mac. */
  label: string;
  dim: boolean;
  onZoom: (scale: number, settled: boolean) => void;
}

const heightAt = (width: number, image: PreviewImage) => Math.round((width * image.height) / image.width);

/**
 * The Mac's page at the view's width, top-aligned, to pinch and pan. Two images: a new frame decodes in the back one
 * and comes forward once loaded, so frames never blink, and the zoom holds across them; another tab's first frame
 * zooms back out. A tap does nothing to the page.
 */
export function FrameView({ frame, label, dim, onZoom }: FrameViewProps) {
  const { width } = useWindowDimensions();
  const zoom = useRef<ZoomViewHandle>(null);
  const [slots, setSlots] = useState<Slots>([frame, null]);
  const [front, setFront] = useState<0 | 1>(0);
  if (slots[0]?.uri !== frame.uri && slots[1]?.uri !== frame.uri) {
    const next: Slots = [...slots];
    next[front === 0 ? 1 : 0] = frame;
    setSlots(next);
  }
  const loaded = (index: 0 | 1, image: PreviewImage) => {
    if (index === front || slots[index]?.uri !== image.uri) return;
    if (slots[front] && slots[front].pane !== image.pane) zoom.current?.reset();
    setFront(index);
    setSlots(index === 0 ? [image, null] : [null, image]);
  };
  useLayoutEffect(markFrameShown, [frame.uri]);
  const height = heightAt(width, slots[front] ?? frame);
  return (
    <ZoomView ref={zoom} width={width} height={height} onZoom={onZoom}>
      <View accessible accessibilityRole="image" accessibilityLabel={label} className={cn(dim && "opacity-50")} style={{ width, height }}>
        {slots.map((image, index) =>
          image ? (
            <Image
              key={index}
              source={{ uri: image.uri }}
              accessible={false}
              accessibilityIgnoresInvertColors
              onLoad={() => loaded(index as 0 | 1, image)}
              className="absolute left-0 top-0"
              style={{ width, height: heightAt(width, image), zIndex: index === front ? 1 : 0 }}
            />
          ) : null,
        )}
      </View>
    </ZoomView>
  );
}
