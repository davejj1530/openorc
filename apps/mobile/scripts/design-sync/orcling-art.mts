import svgpath from "svgpath";
import { ORCLING_ACCESSORIES, ORCLING_EYES, ORCLING_GLASSES, ORCLING_INKS, ORCLING_SHAPES, orclingAccessory, orclingEyes, orclingGlasses } from "../../../../packages/client/src/orcling-art.ts";

const number = (value: number) => String(Math.round(value * 1000) / 1000);

/** An SVG path as Swift PathSteps: absolute, its arcs and shorthand curves expanded, so the extension only replays it. */
function steps(d: string): string {
  if (!d) return "[]";
  const out: string[] = [];
  svgpath(d)
    .abs()
    .unarc()
    .unshort()
    .iterate((segment, _index, x, y) => {
      const [command, ...values] = segment as [string, ...number[]];
      const args = values.map(number).join(", ");
      switch (command) {
        case "M":
          out.push(`.move(${args})`);
          break;
        case "L":
          out.push(`.line(${args})`);
          break;
        case "H":
          out.push(`.line(${number(values[0]!)}, ${number(y)})`);
          break;
        case "V":
          out.push(`.line(${number(x)}, ${number(values[0]!)})`);
          break;
        case "Q":
          out.push(`.quad(${args})`);
          break;
        case "C":
          out.push(`.cubic(${args})`);
          break;
        case "Z":
        case "z":
          out.push(".close");
          break;
        default:
          throw new Error(`An Orcling path kept a ${command} after expanding: ${d}`);
      }
    });
  return `[${out.join(", ")}]`;
}

const quoted = (text: string) => JSON.stringify(text);

/**
 * The phone's notification extension draws an Orcling's face from these: the same shapes, eyes, glasses and accessories
 * as `@openorc/client`'s orcling-art, indexed by the look's numbers.
 */
export function renderOrclingArt(header: string): string {
  const eyes = ORCLING_EYES.map((_, style) => {
    const { path, glints } = orclingEyes(style);
    return `    (path: ${steps(path)}, glints: ${steps(glints)}),`;
  });
  const glasses = ORCLING_GLASSES.map((_, style) => {
    const art = orclingGlasses(style);
    return art ? `    (frames: ${steps(art.frames)}, lenses: ${steps(art.lenses)}),` : "    nil,";
  });
  const accessories = ORCLING_ACCESSORIES.map((_, style) => {
    const art = orclingAccessory(style);
    if (!art) return "    nil,";
    const detail = art.detail ? `(path: ${steps(art.detail.path)}, fill: ${quoted(art.detail.fill)})` : "nil";
    return `    (path: ${steps(art.path)}, fill: ${quoted(art.fill)}, detail: ${detail}),`;
  });
  return [
    `// ${header}`,
    "import CoreGraphics",
    "",
    "/// One step of a face's outline in the app's 100-unit square, its arcs already turned into curves.",
    "enum PathStep {",
    "  case move(CGFloat, CGFloat)",
    "  case line(CGFloat, CGFloat)",
    "  case quad(CGFloat, CGFloat, CGFloat, CGFloat)",
    "  case cubic(CGFloat, CGFloat, CGFloat, CGFloat, CGFloat, CGFloat)",
    "  case close",
    "}",
    "",
    "typealias Accessory = (path: [PathStep], fill: String, detail: (path: [PathStep], fill: String)?)",
    "",
    "enum OrclingArt {",
    "  static let shapes: [[PathStep]] = [",
    ...ORCLING_SHAPES.map((shape) => `    ${steps(shape.path)},`),
    "  ]",
    "  static let eyes: [(path: [PathStep], glints: [PathStep])] = [",
    ...eyes,
    "  ]",
    "  static let glasses: [(frames: [PathStep], lenses: [PathStep])?] = [",
    ...glasses,
    "  ]",
    "  static let accessories: [Accessory?] = [",
    ...accessories,
    "  ]",
    `  static let light = ${quoted(ORCLING_INKS.light)}`,
    `  static let shade = ${quoted(ORCLING_INKS.shade)}`,
    `  static let lens = ${quoted(ORCLING_INKS.lens)}`,
    "}",
    "",
  ].join("\n");
}
