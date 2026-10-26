import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Image, useWindowDimensions, View, type AccessibilityActionEvent } from "react-native";
import { usePanGesture, useTapGesture } from "react-native-gesture-handler";
import { cn } from "../ui/cn";
import { ZoomView, type ZoomViewHandle } from "../ui/ZoomView";
import { fitFrame, frameDistance, framePoint, type FrameFit, type FramePoint } from "./frame-fit";
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
  /** A tap on the picture: a click there, in the frame's pixels. */
  onTap?: (point: FramePoint) => void;
  /** A drag at the whole size: the page scrolls by `dx`, `dy` frame pixels, at `point`. */
  onScroll?: (point: FramePoint, dx: number, dy: number) => void;
}

/** VoiceOver's scroll goes most of a frame, so a line of the last one stays in sight. */
const READER_SCROLL = 0.9;
const READER_ACTIONS = [
  { name: "scrollUp", label: "Scroll Up" },
  { name: "scrollDown", label: "Scroll Down" },
];

const ZOOMED = 1.01;
/** A finger that travels farther than a touch's slop is dragging, not tapping, however quickly it lifts. */
const TAP_SLOP = 10;

/** Two images stacked: a new frame decodes in the back one and comes forward once loaded, so frames never blink. */
function useFrontFrame(frame: PreviewImage, zoom: RefObject<ZoomViewHandle | null>) {
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
  return { slots, front, shown: slots[front] ?? frame, loaded };
}

/** The frame's gestures: a tap clicks, and at the whole size a one-finger drag scrolls the page with the finger. */
function useFrameGestures({
  zoomed,
  fit,
  shown,
  zoom,
  onTap,
  onScroll,
}: { zoomed: boolean; fit: FrameFit; shown: PreviewImage; zoom: RefObject<ZoomViewHandle | null> } & Pick<FrameViewProps, "onTap" | "onScroll">) {
  const at = (x: number, y: number) => framePoint(zoom.current?.contentPoint({ x, y }) ?? { x, y }, fit, shown);
  const tap = useTapGesture({
    numberOfTaps: 1,
    maxDistance: TAP_SLOP,
    runOnJS: true,
    onActivate: (event) => {
      const point = at(event.x, event.y);
      if (point) onTap?.(point);
    },
  });
  const drag = usePanGesture({
    enabled: !zoomed,
    maxPointers: 1,
    runOnJS: true,
    onUpdate: (event) => {
      const point = at(event.x, event.y);
      if (!point) return;
      // The page follows the finger: a drag up scrolls down.
      const by = frameDistance(-event.changeX, -event.changeY, fit, shown);
      onScroll?.(point, by.dx, by.dy);
    },
  });
  return [tap, drag];
}

/**
 * The Mac's page, the whole frame in view at its whole size, to pinch and pan, tap and drag. Zoomed in, a drag pans
 * the picture; at the whole size it scrolls the page, and a tap clicks at any zoom. The zoom holds across frames;
 * another tab's first frame zooms back out.
 */
export function FrameView({ frame, label, dim, onZoom, onTap, onScroll }: FrameViewProps) {
  const window = useWindowDimensions();
  const [view, setView] = useState({ width: window.width, height: Infinity });
  const zoom = useRef<ZoomViewHandle>(null);
  const [zoomed, setZoomed] = useState(false);
  const { slots, front, shown, loaded } = useFrontFrame(frame, zoom);
  useLayoutEffect(markFrameShown, [frame.uri]);
  const fit = fitFrame(view, shown);
  const gestures = useFrameGestures({ zoomed, fit, shown, zoom, onTap, onScroll });
  const zoomedTo = (scale: number, settled: boolean) => {
    setZoomed(scale > ZOOMED);
    onZoom(scale, settled);
  };
  const center = { x: shown.width / 2, y: shown.height / 2 };
  const reader = ({ nativeEvent }: AccessibilityActionEvent) => {
    const by = Math.round(shown.height * READER_SCROLL * 100) / 100;
    if (nativeEvent.actionName === "scrollDown") onScroll?.(center, 0, by);
    if (nativeEvent.actionName === "scrollUp") onScroll?.(center, 0, -by);
  };
  return (
    <View className="flex-1" onLayout={({ nativeEvent }) => setView({ width: nativeEvent.layout.width, height: nativeEvent.layout.height })}>
      <ZoomView ref={zoom} width={view.width} height={fit.height} doubleTap={false} gestures={gestures} onZoom={zoomedTo}>
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel={label}
          accessibilityActions={READER_ACTIONS}
          onAccessibilityAction={reader}
          // VoiceOver activates the middle of the frame, a point nobody aimed at: it clicks nothing.
          onAccessibilityTap={() => undefined}
          className={cn(dim && "opacity-50")}
          style={{ width: view.width, height: fit.height }}
        >
          {slots.map((image, index) =>
            image ? (
              <Image
                key={index}
                source={{ uri: image.uri }}
                accessible={false}
                accessibilityIgnoresInvertColors
                onLoad={() => loaded(index as 0 | 1, image)}
                className="absolute top-0"
                style={{ left: fit.left, width: fit.width, height: Math.round((fit.width * image.height) / image.width), zIndex: index === front ? 1 : 0 }}
              />
            ) : null,
          )}
        </View>
      </ZoomView>
    </View>
  );
}
