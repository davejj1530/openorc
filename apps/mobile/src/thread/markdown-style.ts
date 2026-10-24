import type { MarkdownStyle } from "react-native-enriched-markdown";
import { fonts, syntax, text, type colors } from "../generated/tokens";

type Palette = (typeof colors)[keyof typeof colors];

const reply = text.md;
// Headings take size, not weight: the interface has one weight.
const heading = (step: keyof typeof text, palette: Palette) => ({
  fontFamily: fonts.text,
  fontWeight: "normal",
  fontSize: text[step].size,
  lineHeight: text[step].lineHeight,
  color: palette.ink,
  marginTop: 20,
  marginBottom: 14,
});

/** How prose reads: a reply, or a note such as the narration under a step, which the desktop mutes to 13/20 in ink-3. */
export type MarkdownTone = "reply" | "note";

/**
 * A reply in the desktop's prose recipe (rich-text.css and the transcript's reply rules): 14/22 in the text face and
 * one weight, bold only for the author's emphasis, muted lists with faint 4 pt dots, inline code at 0.86 em on the
 * content fill, code blocks as r16 fills in 12 pt mono at 1.7, links in content ink, tables with hairline rows.
 * `hairline` is the screen's thinnest line.
 */
export function markdownStyle(palette: Palette, mode: keyof typeof syntax, hairline: number, tone: MarkdownTone = "reply"): MarkdownStyle {
  const size = tone === "note" ? text.base : reply;
  const body = { fontFamily: fonts.text, fontSize: size.size, lineHeight: size.lineHeight };
  const code = Math.round(size.size * 0.86);
  return {
    paragraph: { ...body, color: tone === "note" ? palette["ink-3"] : palette.ink, marginTop: 0, marginBottom: 14 },
    h1: heading("title-sm", palette),
    h2: heading("xl", palette),
    h3: heading("lg", palette),
    h4: { ...heading("prose", palette), lineHeight: text.lg.lineHeight },
    h5: { ...heading("prose", palette), lineHeight: text.lg.lineHeight },
    h6: { ...heading("prose", palette), lineHeight: text.lg.lineHeight },
    strong: { fontFamily: fonts.bold, fontWeight: "normal", color: palette.ink },
    em: { fontFamily: fonts.text, fontStyle: "italic" },
    list: {
      ...body,
      color: tone === "note" ? palette["ink-3"] : palette["ink-2"],
      bulletColor: palette["ink-4"],
      bulletSize: 4,
      markerColor: palette["ink-4"],
      gapWidth: 12,
      marginLeft: 0,
      itemSpacing: 8,
      marginTop: 0,
      marginBottom: 14,
    },
    code: { fontFamily: fonts.mono, fontSize: code, color: palette["content-ink"], backgroundColor: palette["content-soft"], borderColor: "transparent" },
    codeBlock: {
      fontFamily: fonts.mono,
      fontSize: 12,
      lineHeight: Math.round(12 * 1.7 * 10) / 10,
      color: palette.ink,
      backgroundColor: palette["surface-2"],
      borderColor: "transparent",
      borderWidth: 0,
      borderRadius: 16,
      padding: 16,
      marginTop: 16,
      marginBottom: 16,
      // The desktop's code themes, which design-sync reads from the Shiki themes the desktop renders code with.
      syntaxColors: syntax[mode],
    },
    link: { fontFamily: fonts.text, color: palette["content-ink"], underline: true },
    blockquote: { ...body, color: palette["ink-2"], borderColor: palette["line-strong"], borderWidth: hairline, gapWidth: 16, backgroundColor: "transparent", marginTop: 16, marginBottom: 16 },
    thematicBreak: { color: palette.line, height: hairline, marginTop: 24, marginBottom: 24 },
    table: {
      fontFamily: fonts.text,
      fontWeight: "normal",
      fontSize: text.base.size,
      lineHeight: Math.round(text.base.size * 1.6 * 10) / 10,
      color: palette.ink,
      headerFontFamily: fonts.text,
      headerTextColor: palette["ink-3"],
      headerBackgroundColor: palette["surface-2"],
      rowEvenBackgroundColor: palette.surface,
      rowOddBackgroundColor: palette.surface,
      borderColor: palette.line,
      borderWidth: hairline,
      borderRadius: 16,
      cellPaddingHorizontal: 14,
      cellPaddingVertical: 10,
      marginTop: 16,
      marginBottom: 16,
    },
    taskList: { checkedColor: palette.ink, borderColor: palette["line-strong"], checkmarkColor: palette.surface, checkedTextColor: palette["ink-3"], checkedStrikethrough: false },
  };
}
