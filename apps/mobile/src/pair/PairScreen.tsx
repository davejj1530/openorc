import { CameraView, useCameraPermissions } from "expo-camera";
import * as Clipboard from "expo-clipboard";
import { useLinkingURL } from "expo-linking";
import { router } from "expo-router";
import { useEffect } from "react";
import { Linking, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { primeLocalNetwork } from "../connection/local-network";
import { X } from "../generated/icons";
import { cn } from "../ui/cn";
import { useColors } from "../ui/mode";
import { SheetStatusBar } from "../ui/SheetStatusBar";
import { Text } from "../ui/Text";
import { offerCode, openPairing, retryPairing, scanCode, usePairing, type Pairing } from "./pairing";

function pairingLine(pairing: Pairing): string {
  switch (pairing.kind) {
    case "idle":
      return "Scan the code OpenOrc shows on your Mac.";
    case "pairing":
      return "Pairing…";
    case "failed":
      return pairing.message;
  }
}

/**
 * Back to Home. Pairing another Mac also takes the phone Home on its own (the layout's leaveOnMacChange); a second
 * dismissTo where Home already shows does nothing, where dismissAll or back would find nothing to close.
 */
function leave(): void {
  router.dismissTo("/");
}

const pair = (code: string) => void offerCode(code).then((ok) => ok && leave());
const scan = (code: string) => void scanCode(code).then((ok) => ok && leave());

/** A faint text button, touch height. */
function LineAction({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} className="-mx-3 min-h-touch justify-center rounded-full px-3 active:bg-surface-2">
      <Text className="text-ink-3">{label}</Text>
    </Pressable>
  );
}

/** The camera, asked for as the screen opens: the reason for it is on screen. */
function Scanner() {
  const [permission, request] = useCameraPermissions();
  const undecided = permission && !permission.granted && permission.canAskAgain;
  useEffect(() => {
    if (undecided) void request();
  }, [undecided, request]);
  if (permission?.granted) {
    return (
      <CameraView
        accessibilityLabel="Camera, point at the pairing code"
        accessibilityIgnoresInvertColors
        style={{ flex: 1 }}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => scan(data)}
      />
    );
  }
  return (
    <View className="flex-1 items-center justify-center px-6">
      {permission && !permission.canAskAgain ? (
        <>
          <Text className="text-center text-ink-4">Camera access for OpenOrc is off.</Text>
          <LineAction label="Open Settings" onPress={() => void Linking.openSettings()} />
        </>
      ) : null}
    </View>
  );
}

/** The pairing link from the Mac's Copy link, through the system's own Paste control: no prompt, no keyboard. */
function PasteLink() {
  const colors = useColors();
  return (
    <View className="mt-auto min-h-touch flex-row items-center justify-between gap-3">
      <Text className="min-w-0 flex-shrink text-ink-4">Or paste the link from your Mac</Text>
      {Clipboard.isPasteButtonAvailable ? (
        <Clipboard.ClipboardPasteButton
          acceptedContentTypes={["plain-text"]}
          displayMode="iconAndLabel"
          // The control takes opaque colors only: the plain surface, so the screen's one ink pill stays the scanner's own.
          backgroundColor={colors.surface}
          foregroundColor={colors.ink}
          style={{ width: 104, height: 44 }}
          onPress={(data) => data.type === "text" && pair(data.text)}
        />
      ) : (
        <Pressable accessibilityRole="button" onPress={() => void Clipboard.getStringAsync().then(pair)} className="h-touch justify-center rounded-full bg-surface-2 px-5 active:bg-surface-3">
          <Text className="text-md">Paste</Text>
        </Pressable>
      )}
    </View>
  );
}

/** Scans the code the Mac shows, takes a pasted link, or spends one the system camera opened the app with. */
export function PairScreen() {
  const insets = useSafeAreaInsets();
  const pairing = usePairing((state) => state.pairing);
  const opened = useLinkingURL();

  // Before the link it opened with, so a failure from an earlier visit does not show over a fresh start.
  useEffect(openPairing, []);
  useEffect(() => {
    if (opened) pair(opened);
  }, [opened]);
  // The first dial on this Wi-Fi brings up iOS's Local Network prompt; it goes now, not in the middle of a pairing.
  useEffect(primeLocalNetwork, []);

  return (
    <View className="flex-1 bg-bg px-5" style={{ paddingTop: 16, paddingBottom: insets.bottom + 16 }} onAccessibilityEscape={leave}>
      <SheetStatusBar />
      <View className="h-touch flex-row items-center justify-between">
        <Text accessibilityRole="header" className="text-xl">
          Pair with your Mac
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={leave} className="size-11 items-center justify-center rounded-full active:bg-surface-2">
          <X size={18} className="text-ink-3" />
        </Pressable>
      </View>
      <View className="mt-4 aspect-square overflow-hidden rounded-xl bg-surface">
        <Scanner />
      </View>
      <View className="mt-3 min-h-touch flex-row items-center gap-3">
        <Text className={cn("flex-1 text-ink-4", pairing.kind === "failed" && "text-bad")}>{pairingLine(pairing)}</Text>
        {pairing.kind === "failed" && !pairing.spent ? <LineAction label="Try again" onPress={() => void retryPairing().then((ok) => ok && leave())} /> : null}
      </View>
      <PasteLink />
    </View>
  );
}
