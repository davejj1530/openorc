import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { decompress } from "wawoff2";

export type FontOutput = { path: string; contents: Uint8Array; postScriptName: string };

/** The PostScript name (name ID 6) of a TrueType font, which is the family name iOS registers the face under. */
export function postScriptName(font: Uint8Array): string {
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const tables = view.getUint16(4);
  for (let index = 0; index < tables; index++) {
    const record = 12 + index * 16;
    if (String.fromCharCode(...font.subarray(record, record + 4)) !== "name") continue;
    const table = view.getUint32(record + 8);
    const count = view.getUint16(table + 2);
    const strings = table + view.getUint16(table + 4);
    for (let entry = 0; entry < count; entry++) {
      const at = table + 6 + entry * 12;
      if (view.getUint16(at + 6) !== 6) continue;
      const start = strings + view.getUint16(at + 10);
      // Macintosh names are single-byte Roman, which is ASCII for a PostScript name; Unicode and Windows names are UTF-16BE.
      return new TextDecoder(view.getUint16(at) === 1 ? "latin1" : "utf-16be").decode(font.subarray(start, start + view.getUint16(at + 8)));
    }
  }
  throw new Error("The font has no PostScript name");
}

/**
 * The desktop's Immaculate Gothic faces, decoded from WOFF2 into the TrueType files Expo embeds. Each file is named
 * after the face's PostScript name, which is what the app asks iOS for. The font's provenance stays recorded in
 * licenses/vendor/immaculate-gothic-PROVENANCE.txt.
 */
export async function convertFonts(sources: readonly string[], outDir: string): Promise<FontOutput[]> {
  const fonts: FontOutput[] = [];
  // One at a time, copied out: the decoder returns a view into its WebAssembly memory, which the next call reuses.
  for (const source of sources) {
    const contents = (await decompress(await readFile(source))).slice();
    const name = postScriptName(contents);
    const expected = basename(source, ".woff2");
    if (name !== expected) throw new Error(`${source} is named ${name}; the phone expects ${expected}`);
    fonts.push({ path: resolve(outDir, `${name}.ttf`), contents, postScriptName: name });
  }
  return fonts;
}
