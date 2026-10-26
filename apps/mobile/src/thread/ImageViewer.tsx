import { StatusBar } from "expo-status-bar";
import { useState, type ReactNode } from "react";
import { Image, Modal, Pressable, Share, useWindowDimensions, View } from "react-native";
import { usePanGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { Upload, X } from "../generated/icons";
import { ZoomView } from "../ui/ZoomView";
import { groundOpacity, swipeCloses } from "./viewer-gestures";

/** A round control over the image. */
function Control({ label, onPress, children }: { label: string; onPress: () => void; children: ReactNode }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} className="size-touch items-center justify-center rounded-full bg-surface active:bg-surface-3">
      {children}
    </Pressable>
  );
}

/**
 * An image full screen on the tile, as Photos shows one: pinch or double tap to zoom, swipe it down to leave (it follows
 * the finger and the ground fades), Share for the system's sheet, which saves to Photos too. The status bar steps aside.
 */
export function ImageViewer({ uri, label, onClose }: { uri: string; label: string; onClose: () => void }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // Zoomed in, a drag pans the image; at its whole size, a drag down takes it away.
  const [zoomed, setZoomed] = useState(false);
  const drop = useSharedValue(0);
  const swipeDown = usePanGesture({
    activeOffsetY: 12,
    failOffsetX: [-24, 24],
    enabled: !zoomed,
    onUpdate: (event) => {
      "worklet";
      drop.value = Math.max(0, event.translationY);
    },
    onDeactivate: (event) => {
      "worklet";
      if (swipeCloses(event.translationY, event.velocityY)) {
        drop.value = withTiming(height, { duration: 180 });
        scheduleOnRN(onClose);
      } else drop.value = withSpring(0);
    },
  });
  const image = useAnimatedStyle(() => ({ transform: [{ translateY: drop.value }] }));
  const ground = useAnimatedStyle(() => ({ opacity: groundOpacity(drop.value, height) }));
  return (
    <Modal visible animationType="fade" presentationStyle="overFullScreen" transparent onRequestClose={onClose}>
      <StatusBar hidden />
      <View className="flex-1" onAccessibilityEscape={onClose}>
        <Animated.View className="absolute inset-0 bg-bg" style={ground} />
        <Animated.View className="flex-1" style={image}>
          <ZoomView width={width} height={height} centered gesture={swipeDown} onZoom={(scale) => setZoomed(scale > 1.01)}>
            <Image source={{ uri }} accessibilityLabel={label} accessibilityIgnoresInvertColors style={{ width, height }} resizeMode="contain" />
          </ZoomView>
        </Animated.View>
        <View className="absolute inset-x-3 flex-row justify-between" style={{ top: insets.top + 8 }}>
          <Control label="Share" onPress={() => void Share.share({ url: uri })}>
            <Upload size={18} />
          </Control>
          <Control label="Close" onPress={onClose}>
            <X size={18} />
          </Control>
        </View>
      </View>
    </Modal>
  );
}
