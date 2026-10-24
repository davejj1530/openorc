import { citationLinks } from "@openorc/client";
import * as Haptics from "expo-haptics";
import { memo, useEffect, useMemo } from "react";
import { Linking, StyleSheet } from "react-native";
import { EnrichedMarkdownText, type LinkPressEvent } from "react-native-enriched-markdown";
import remend from "remend";
import { useColors, useMode } from "../ui/mode";
import { markdownStyle, type MarkdownTone } from "./markdown-style";
import { countMarkdownMount } from "./perf-probe";

/** A link the phone can follow. Files on the Mac read as references; the phone has no file panel to open them in. */
const webLink = (url: string) => /^(https?:|mailto:)/i.test(url);

function openLink({ url }: LinkPressEvent) {
  if (webLink(url)) void Linking.openURL(url);
}

/** A copied code block confirms itself with the light tap the desktop shows as a check. */
const copied = () => void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

const streamingConfig = { tableMode: "progressive", codeBlockMode: "progressive" } as const;
const remendOptions = { linkMode: "text-only" } as const;

/**
 * A reply as native Markdown, or a muted note in the reply's recipe. While it streams, the unfinished tail is closed
 * off (an open fence, a half link) so it renders as it will once complete, and new words fade in on the desktop's
 * schedule.
 */
export const Markdown = memo(function Markdown({ text, streaming, tone = "reply" }: { text: string; streaming: boolean; tone?: MarkdownTone }) {
  const mode = useMode();
  const palette = useColors();
  useEffect(countMarkdownMount, []);
  const style = useMemo(() => {
    const base = markdownStyle(palette, mode, StyleSheet.hairlineWidth, tone);
    // A file the agent cites reads as code, not as a link to follow.
    return { ...base, linkVariants: { "^(?!https?:|mailto:)": { color: palette["content-ink"], underline: false, backgroundColor: palette["content-soft"] } } };
  }, [palette, mode, tone]);
  const markdown = useMemo(() => {
    const linked = citationLinks(text);
    return streaming ? remend(linked, remendOptions) : linked;
  }, [text, streaming]);
  return (
    <EnrichedMarkdownText
      flavor="github"
      markdown={markdown}
      markdownStyle={style}
      streamingAnimation={streaming}
      streamingConfig={streamingConfig}
      selectable
      allowTrailingMargin={false}
      onLinkPress={openLink}
      onCopyPress={copied}
    />
  );
});
