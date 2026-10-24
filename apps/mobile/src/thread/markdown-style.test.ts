import { describe, expect, it } from "vitest";
import { colors, fonts } from "../generated/tokens";
import { markdownStyle } from "./markdown-style";

describe("markdownStyle", () => {
  const light = markdownStyle(colors.light, "light", 0.5);
  const dark = markdownStyle(colors.dark, "dark", 0.5);

  it("sets a reply at the desktop's 14/22 in the text face, bold only in the Bold face", () => {
    expect(light.paragraph).toMatchObject({ fontFamily: fonts.text, fontSize: 14, lineHeight: 22, color: colors.light.ink, marginBottom: 14 });
    expect(light.strong).toEqual({ fontFamily: fonts.bold, fontWeight: "normal", color: colors.light.ink });
    expect(light.h3).toMatchObject({ fontFamily: fonts.text, fontWeight: "normal", fontSize: 16, lineHeight: 22 });
    expect(light.table).toMatchObject({ fontFamily: fonts.text, fontWeight: "normal" });
  });

  it("mutes lists behind faint 4 pt dots and keeps code in the desktop's fills", () => {
    expect(light.list).toMatchObject({ color: colors.light["ink-2"], bulletColor: colors.light["ink-4"], bulletSize: 4, itemSpacing: 8 });
    expect(light.code).toMatchObject({ fontFamily: fonts.mono, fontSize: 12, color: colors.light["content-ink"], backgroundColor: colors.light["content-soft"] });
    expect(light.codeBlock).toMatchObject({ fontFamily: fonts.mono, fontSize: 12, lineHeight: 20.4, borderRadius: 16, backgroundColor: colors.light["surface-2"], borderWidth: 0 });
  });

  it("underlines links in content ink and draws table rows with hairlines", () => {
    expect(light.link).toMatchObject({ color: colors.light["content-ink"], underline: true });
    expect(light.table).toMatchObject({
      borderColor: colors.light.line,
      borderWidth: 0.5,
      borderRadius: 16,
      headerTextColor: colors.light["ink-3"],
      cellPaddingHorizontal: 14,
      cellPaddingVertical: 10,
    });
    expect(light.table).toMatchObject({ headerBackgroundColor: colors.light["surface-2"], rowEvenBackgroundColor: colors.light.surface, rowOddBackgroundColor: colors.light.surface });
  });

  it("reads a note (narration under a step) at 13/20 in ink-3, as the desktop's muted note, emphasis still in ink", () => {
    const note = markdownStyle(colors.light, "light", 0.5, "note");
    expect(note.paragraph).toMatchObject({ fontFamily: fonts.text, fontSize: 13, lineHeight: 20, color: colors.light["ink-3"], marginBottom: 14 });
    expect(note.list).toMatchObject({ fontSize: 13, lineHeight: 20, color: colors.light["ink-3"], bulletColor: colors.light["ink-4"] });
    expect(note.strong).toEqual(light.strong);
    expect(note.code).toEqual({ ...light.code, fontSize: 11 });
  });

  it("follows the mode: dark paints the dark palette and the dark code theme", () => {
    expect(dark.paragraph?.color).toBe(colors.dark.ink);
    expect(dark.codeBlock?.backgroundColor).toBe(colors.dark["surface-2"]);
    expect(dark.codeBlock?.syntaxColors?.keyword).not.toBe(light.codeBlock?.syntaxColors?.keyword);
  });
});
