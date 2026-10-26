import { useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import { ScrollView, View, type NativeScrollEvent, type NativeSyntheticEvent, type ScrollViewInstance } from "react-native";
import { GestureDetector, useSimultaneousGestures, useTapGesture, type PanGesture } from "react-native-gesture-handler";
import { doubleTapRect } from "./zoom";

/** Zooms back to the whole content: for new content the old zoom does not fit. */
export interface ZoomViewHandle {
  reset(): void;
}

interface ZoomViewProps {
  /** The content's size at its whole size. */
  width: number;
  height: number;
  /** Centered in the view, as a photo is; else at its top, as a page is. */
  centered?: boolean;
  /** Recognized alongside the double tap, such as a viewer's swipe down. */
  gesture?: PanGesture;
  /** How far it zoomed; `settled` once a pinch or a double tap ends there. */
  onZoom?: (scale: number, settled: boolean) => void;
  ref?: Ref<ZoomViewHandle>;
  children: ReactNode;
}

const MAX_ZOOM = 4;

/**
 * Content to pinch and pan, from its whole size up to four times, as Photos zooms: a double tap comes twice as close
 * around the tapped point, or goes back to the whole. Unzoomed, content no taller than the view does not scroll, so a
 * drag down stays with `gesture`.
 */
export function ZoomView({ width, height, centered = false, gesture, onZoom, ref, children }: ZoomViewProps) {
  const scroll = useRef<ScrollViewInstance>(null);
  const [zoomed, setZoomed] = useState(false);
  const view = useRef({ width, height });
  const at = useRef({ scale: 1, x: 0, y: 0 });
  // A double tap zooming out: once it settles, a page goes back to its top.
  const zoomingOut = useRef(false);
  const zoomTo = (rect: ReturnType<typeof doubleTapRect>, animated: boolean) => scroll.current?.scrollResponderZoomTo({ ...rect, animated });
  const toTop = (animated: boolean) => scroll.current?.scrollTo({ x: 0, y: 0, animated });
  useImperativeHandle(ref, () => ({
    reset: () => {
      // Zooming to a rect centers what is shorter than the view, so at its whole size only the scroll goes back.
      if (at.current.scale > 1.01) zoomTo(doubleTapRect({ x: 0, y: 0 }, { width, height }, true, view.current), false);
      toTop(false);
      at.current = { scale: 1, x: 0, y: 0 };
      setZoomed(false);
      onZoom?.(1, true);
    },
  }));
  const doubleTap = useTapGesture({
    numberOfTaps: 2,
    runOnJS: true,
    onActivate: (event) => {
      const { scale, x, y } = at.current;
      zoomingOut.current = zoomed && !centered;
      zoomTo(doubleTapRect({ x: (event.x + x) / scale, y: (event.y + y) / scale }, { width, height }, zoomed, view.current), true);
    },
  });
  const gestures = useSimultaneousGestures(doubleTap, ...(gesture ? [gesture] : []));
  const read =
    (settled: boolean) =>
    ({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
      const scale = nativeEvent.zoomScale ?? 1;
      at.current = { scale, x: nativeEvent.contentOffset?.x ?? at.current.x, y: nativeEvent.contentOffset?.y ?? at.current.y };
      setZoomed(scale > 1.01);
      onZoom?.(scale, settled);
      if (!settled || !zoomingOut.current || scale > 1.01) return;
      zoomingOut.current = false;
      toTop(true);
    };
  return (
    <GestureDetector gesture={gestures}>
      <View className="flex-1">
        <ScrollView
          ref={scroll}
          maximumZoomScale={MAX_ZOOM}
          minimumZoomScale={1}
          centerContent={centered}
          // Unzoomed, content the view holds has nothing to scroll and must not take the drag down from `gesture`.
          alwaysBounceVertical={zoomed}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          bouncesZoom
          scrollEventThrottle={32}
          onLayout={({ nativeEvent }) => (view.current = { width: nativeEvent.layout.width, height: nativeEvent.layout.height })}
          onScroll={read(false)}
          // The throttled scroll events can miss a zoom's last step; its end reports the scale it settled at.
          onScrollEndDrag={read(true)}
          onMomentumScrollEnd={read(true)}
        >
          {children}
        </ScrollView>
      </View>
    </GestureDetector>
  );
}
