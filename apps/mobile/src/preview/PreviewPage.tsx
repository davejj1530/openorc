import type { PreviewFocus } from "@openorc/protocol";
import { useEffect } from "react";
import { ActionSheetIOS, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { FrameView } from "./FrameView";
import { PreviewKeys } from "./PreviewKeys";
import type { PreviewImage } from "./use-preview";
import type { usePreviewInput } from "./use-preview-input";

/** The keys bar's height over the keyboard: a 44 pt key, its padding and the hairline. */
const KEYS_BAR = 53;

type Input = ReturnType<typeof usePreviewInput>;

/** A select focused on the Mac: its options in the phone's own sheet, as its native menu would list them there. */
function useChoices(focus: PreviewFocus | null, choose: Input["choose"], release: Input["release"]) {
  useEffect(() => {
    if (focus?.kind !== "choice") return;
    const labels = focus.options.map((option) => option.label);
    const disabledButtonIndices = focus.options.flatMap((option, index) => (option.disabled ? [index] : []));
    ActionSheetIOS.showActionSheetWithOptions({ options: [...labels, "Cancel"], cancelButtonIndex: labels.length, disabledButtonIndices }, (index) =>
      index < labels.length ? choose(index) : release(),
    );
  }, [focus, choose, release]);
}

interface PreviewPageProps {
  frame: PreviewImage;
  /** VoiceOver's name for the frame: the page and the Mac. */
  label: string;
  /** The page, for the field that types into it. */
  page: string;
  dim: boolean;
  onZoom: (scale: number, settled: boolean) => void;
  input: Input;
}

/** The page to drive: the frame, the keyboard while the Mac's focus takes typing, which the frame fits above. */
export function PreviewPage({ frame, label, page, dim, onZoom, input }: PreviewPageProps) {
  const keyboard = useKeyboardState((state) => (state.isVisible ? state.height : 0));
  const text = input.focus?.kind === "text" ? input.focus : null;
  useChoices(input.focus, input.choose, input.release);
  return (
    <View className="flex-1" style={{ paddingBottom: text ? keyboard + KEYS_BAR : 0 }}>
      {/* Dimmed, the Mac is out of reach: the page can be looked at, not driven. */}
      <FrameView frame={frame} label={label} dim={dim} onZoom={onZoom} onTap={dim ? undefined : input.tap} onScroll={dim ? undefined : input.scroll} />
      <PreviewKeys focus={text} field={input.field} label={page} onInputs={input.type} onEnd={input.release} />
    </View>
  );
}
