import type { Quote } from "@openorc/client";
import { useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";
import { Quote as QuoteIcon, X } from "../generated/icons";
import { Passage } from "../thread/quoting";
import { Text } from "../ui/Text";

/** The whole passage shows up to this height in an open quote, then scrolls. */
const PASSAGE_MAX = 132;

export interface QuoteWriters {
  /** Writes what the person says about a passage. */
  onNote: (id: string, note: string) => void;
  onRemove: (id: string) => void;
  /** A quote's note took or gave up the keyboard. */
  onFocusChange?: ((focused: boolean) => void) | undefined;
}

/**
 * A quote in the draft: the passage on one line over its note. Tapped, it opens into the whole passage and the note to
 * write, and closes when the note gives up the keyboard.
 */
function ComposerQuote({ quote, open, onOpen, onNote, onRemove, onFocusChange }: { quote: Quote; open: boolean; onOpen: (open: boolean) => void } & QuoteWriters) {
  const remove = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Remove quote"
      onPress={() => onRemove(quote.id)}
      hitSlop={11}
      className="size-5.5 items-center justify-center rounded-full active:bg-surface-3"
    >
      <X size={12} className="text-ink-4" />
    </Pressable>
  );
  if (!open)
    return (
      <View className="flex-row items-center gap-2.5 rounded-xl bg-key py-2 pl-3 pr-2.5">
        <Pressable accessibilityRole="button" accessibilityLabel={`Quote: ${quote.text}`} onPress={() => onOpen(true)} className="min-w-0 flex-1 flex-row items-center gap-2.5 active:opacity-60">
          <QuoteIcon size={16} className="text-ink-4" />
          <View className="min-w-0 flex-1">
            <Text numberOfLines={1} className="text-sm text-ink-2">
              {quote.text}
            </Text>
            {quote.note ? (
              <Text numberOfLines={1} className="text-sm text-ink-4">
                {quote.note}
              </Text>
            ) : null}
          </View>
        </Pressable>
        {remove}
      </View>
    );
  return (
    <View className="gap-2.5 rounded-xl bg-key py-2.5 pl-3 pr-2.5">
      <View className="flex-row items-start gap-2.5">
        <ScrollView className="min-w-0 flex-1" style={{ maxHeight: PASSAGE_MAX }}>
          <Passage>
            <Text className="text-sm text-ink-2">{quote.text}</Text>
          </Passage>
        </ScrollView>
        {remove}
      </View>
      <TextInput
        multiline
        autoFocus
        defaultValue={quote.note}
        onChangeText={(note) => onNote(quote.id, note)}
        onFocus={() => onFocusChange?.(true)}
        onBlur={() => {
          onNote(quote.id, quote.note.trim());
          onFocusChange?.(false);
          onOpen(false);
        }}
        placeholder="Add a note"
        accessibilityLabel="Note"
        className="max-h-20 p-0 font-sans text-md leading-5 text-ink"
        placeholderTextColorClassName="accent-ink-4"
      />
    </View>
  );
}

/** The passages the draft quotes, over the prompt: one opens at a time. */
export function ComposerQuotes({ quotes, ...writers }: { quotes: readonly Quote[] } & QuoteWriters) {
  const [open, setOpen] = useState<string | null>(null);
  // A note that gives up the keyboard closes its own quote, never the one tapped open after it.
  const show = (id: string, opened: boolean) =>
    setOpen((current) => {
      if (opened) return id;
      return current === id ? null : current;
    });
  if (!quotes.length) return null;
  return (
    <View className="gap-2">
      {quotes.map((quote) => (
        <ComposerQuote key={quote.id} quote={quote} open={open === quote.id} onOpen={(opened) => show(quote.id, opened)} {...writers} />
      ))}
    </View>
  );
}
