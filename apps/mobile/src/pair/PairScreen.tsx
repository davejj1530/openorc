import { CameraView, useCameraPermissions } from "expo-camera";
import { useLinkingURL } from "expo-linking";
import { router } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { X } from "../generated/icons";
import { cn } from "../ui/cn";
import { Text } from "../ui/Text";
import { isPairingUrl, pairWith, usePairing, type Pairing } from "./pairing";

/** Codes already tried, so the scanner seeing the same code again, or the same link, does not retry it in a loop. */
const tried = new Set<string>();

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

function leave(): void {
  if (router.canDismiss()) router.dismissAll();
  else router.replace("/");
}

function Scanner({ onCode }: { onCode(code: string): void }) {
  const [permission, request] = useCameraPermissions();
  if (permission?.granted) {
    return <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={({ data }) => onCode(data)} />;
  }
  return (
    <View className="flex-1 items-center justify-center gap-3 px-6">
      {permission && !permission.canAskAgain ? (
        <Text className="text-center text-ink-4">Camera access for OpenOrc is off in Settings.</Text>
      ) : (
        <Pressable accessibilityRole="button" onPress={() => void request()} className="h-touch justify-center rounded-full bg-surface-2 px-5 active:opacity-80">
          <Text className="text-md">Allow the camera</Text>
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
  const [text, setText] = useState("");

  const submit = useCallback((code: string) => {
    if (!isPairingUrl(code) || tried.has(code)) return;
    tried.add(code);
    void pairWith(code).then((ok) => ok && leave());
  }, []);

  useEffect(() => {
    if (opened) submit(opened);
  }, [opened, submit]);

  const canPair = text.trim().length > 0 && pairing.kind !== "pairing";
  return (
    <View className="flex-1 bg-bg px-5" style={{ paddingTop: 16, paddingBottom: insets.bottom + 16 }}>
      <View className="h-touch flex-row items-center justify-between">
        <Text accessibilityRole="header" className="text-xl">
          Pair with your Mac
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={leave} className="size-11 items-center justify-center rounded-full active:bg-surface-2">
          <X size={18} className="text-ink-3" />
        </Pressable>
      </View>
      <View className="mt-4 aspect-square overflow-hidden rounded-xl bg-surface">
        <Scanner onCode={submit} />
      </View>
      <Text className={cn("mt-3 min-h-5 text-ink-4", pairing.kind === "failed" && "text-bad")}>{pairingLine(pairing)}</Text>
      <View className="mt-auto flex-row items-center gap-2">
        <TextInput
          value={text}
          onChangeText={setText}
          onSubmitEditing={() => canPair && submit(text.trim())}
          placeholder="Or paste the pairing link"
          placeholderTextColorClassName="accent-ink-4"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="go"
          className="h-touch flex-1 rounded-full bg-surface px-4 font-sans text-md text-ink"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canPair }}
          disabled={!canPair}
          onPress={() => submit(text.trim())}
          className={cn("h-touch justify-center rounded-full bg-accent px-5 active:opacity-80", !canPair && "opacity-40")}
        >
          <Text className="text-md text-accent-fg">Pair</Text>
        </Pressable>
      </View>
    </View>
  );
}
