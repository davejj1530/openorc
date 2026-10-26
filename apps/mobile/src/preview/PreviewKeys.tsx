import type { PreviewEnterKey, PreviewFocus, PreviewInput, PreviewKeyboard } from "@openorc/protocol";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Keyboard, Pressable, StyleSheet, TextInput, View, type KeyboardTypeOptions, type ReturnKeyTypeOptions, type TextInputInstance } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { ArrowRight, ChevronDown } from "../generated/icons";
import { textEdits } from "./text-edits";

type TextFocus = Extract<PreviewFocus, { kind: "text" }>;

const KEYBOARDS: Record<PreviewKeyboard, KeyboardTypeOptions> = {
  default: "default",
  email: "email-address",
  url: "url",
  numeric: "numbers-and-punctuation",
  decimal: "decimal-pad",
  tel: "phone-pad",
  search: "web-search",
};
const RETURN_KEYS: Record<PreviewEnterKey, ReturnKeyTypeOptions> = { default: "default", go: "go", next: "next", search: "search", send: "send", done: "done" };
/** The bar rides on the keyboard, across the screen's foot. */
const BAR = { position: "absolute", left: 0, right: 0, bottom: 0 } as const;
/** Addresses, numbers and passwords are typed as they are: no capitals, no corrections. */
const LITERAL: PreviewKeyboard[] = ["email", "url", "numeric", "decimal", "tel"];

interface PreviewKeysProps {
  /** The Mac's focused field, or null while none takes typing. */
  focus: TextFocus | null;
  /** Counts the times the phone's field starts empty: each field the focus moved to, and each refusal. */
  field: number;
  /** The page, for VoiceOver. */
  label: string;
  onInputs: (inputs: PreviewInput[]) => void;
  /** The keyboard went away. */
  onEnd: () => void;
}

function Key({ label, onPress, children }: { label: string; onPress: () => void; children: ReactNode }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} className="size-touch items-center justify-center rounded-full active:bg-surface-2">
      {children}
    </Pressable>
  );
}

/** The keys before any field: what an ordinary text field asks for. */
const PLAIN: TextFocus = { kind: "text", keyboard: "default", enter: "default", secure: false, multiline: false };

/** The phone field's traits for the Mac's field: its keys, its return key, and no corrections where text is literal. */
function traits(focus: TextFocus) {
  const literal = focus.secure || LITERAL.includes(focus.keyboard);
  return {
    keyboardType: KEYBOARDS[focus.keyboard],
    returnKeyType: RETURN_KEYS[focus.enter],
    secureTextEntry: focus.secure,
    multiline: focus.multiline,
    autoCapitalize: literal ? ("none" as const) : ("sentences" as const),
    autoCorrect: !literal,
  };
}

/**
 * The phone's keyboard for the Mac's focused field: a field of the phone's own, out of sight, whose edits stream to
 * the Mac as they happen, so autocorrect, predictions, dictation and paste land as typed. Its value never comes from the
 * Mac. Above the keys, Tab moves the Mac's focus and Done puts the keyboard away. The field stays mounted between
 * fields, so it is blurred, never unmounted while it has the keyboard.
 */
export function PreviewKeys({ focus, field, label, onInputs, onEnd }: PreviewKeysProps) {
  const input = useRef<TextInputInstance>(null);
  const [text, setText] = useState("");
  const typed = useRef("");
  const last = useRef<TextFocus>(PLAIN);
  if (focus) last.current = focus;
  const typing = focus !== null;
  const typingNow = useRef(typing);
  typingNow.current = typing;
  useEffect(() => {
    typed.current = "";
    setText("");
  }, [field]);
  useEffect(() => {
    if (typing) input.current?.focus();
    else Keyboard.dismiss();
  }, [typing, field]);
  const change = (next: string) => {
    onInputs(textEdits(typed.current, next));
    typed.current = next;
    setText(next);
  };
  return (
    <>
      <TextInput
        ref={input}
        value={text}
        onChangeText={change}
        // Backspace in an empty field changes no text, but the Mac's field may still hold some before its caret.
        onKeyPress={({ nativeEvent }) => nativeEvent.key === "Backspace" && typed.current === "" && onInputs([{ kind: "key", key: "Backspace", count: 1 }])}
        onSubmitEditing={() => onInputs([{ kind: "key", key: "Enter", count: 1 }])}
        submitBehavior="submit"
        // Blurred because the Mac's focus left a field, typing has already ended.
        onBlur={() => typingNow.current && onEnd()}
        {...traits(last.current)}
        accessibilityLabel={label}
        accessibilityElementsHidden={!typing}
        className="absolute left-0 top-0 h-px w-px opacity-0"
      />
      {typing ? (
        <KeyboardStickyView style={BAR}>
          <View className="bg-line" style={{ height: StyleSheet.hairlineWidth }} />
          <View className="flex-row items-center justify-between bg-bg px-2 py-1">
            <Key label="Tab" onPress={() => onInputs([{ kind: "key", key: "Tab", count: 1 }])}>
              <ArrowRight size={18} />
            </Key>
            {/* Typing ends, and the keyboard goes with the field it typed into. */}
            <Key label="Done" onPress={onEnd}>
              <ChevronDown size={18} />
            </Key>
          </View>
        </KeyboardStickyView>
      ) : null}
    </>
  );
}
