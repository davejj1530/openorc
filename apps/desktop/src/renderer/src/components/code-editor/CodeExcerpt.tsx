import { useEffect, useState } from "react";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { highlightCode } from "@lezer/highlight";
import { highlight, syntaxColors, syntaxVariables } from "./theme";
import "./excerpt.css";

type Token = { text: string; classes: string };
type Lines = Token[][];

/** The last few files highlighted, so every excerpt of one file shares a single parse. */
const parsed = new Map<string, Promise<Lines | null>>();
const KEPT = 6;
const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

let styled = false;
/** Excerpts live outside any editor, so they mount the editor's syntax classes and colors themselves. */
function mountStyles(): void {
  if (styled) return;
  styled = true;
  const variables = (colors: Record<string, string>) =>
    Object.entries(syntaxVariables(colors))
      .map(([name, value]) => `${name}:${value}`)
      .join(";");
  const style = document.createElement("style");
  style.textContent = `${highlight.module?.getRules() ?? ""}\n.code-excerpt{${variables(syntaxColors.light)}}\n.dark .code-excerpt{${variables(syntaxColors.dark)}}`;
  document.head.append(style);
}

async function highlightFile(text: string, path: string): Promise<Lines | null> {
  const support = await LanguageDescription.matchFilename(languages, fileName(path))
    ?.load()
    .catch(() => null);
  if (!support) return null;
  const lines: Lines = [[]];
  highlightCode(
    text,
    support.language.parser.parse(text),
    highlight,
    (code, classes) => lines.at(-1)!.push({ text: code, classes }),
    () => lines.push([]),
  );
  return lines;
}

function useHighlighted(text: string, path: string): Lines | null {
  const key = `${path}\0${text}`;
  const [lines, setLines] = useState<{ key: string; lines: Lines | null } | null>(null);
  useEffect(() => {
    mountStyles();
    let current = parsed.get(key);
    if (!current) {
      current = highlightFile(text, path);
      parsed.set(key, current);
      for (const old of [...parsed.keys()].slice(0, -KEPT)) parsed.delete(old);
    }
    let alive = true;
    void current.then((value) => alive && setLines({ key, lines: value }));
    return () => {
      alive = false;
    };
  }, [key, text, path]);
  return lines?.key === key ? lines.lines : null;
}

/**
 * Lines `start` to `end` of a file, highlighted in the editor's colors with their line numbers. Until the language
 * loads, and for a file type with no grammar, the lines show plain. `text` uses LF line breaks.
 */
export function CodeExcerpt({ text, path, start, end, wrap }: { text: string; path: string; start: number; end: number; wrap: boolean }) {
  const lines = useHighlighted(text, path);
  const plain = text.split("\n");
  // Sized for the whole file, so every excerpt of it lines its code up at the same column.
  const width = String(plain.length).length;
  return (
    <pre className="code-excerpt" data-wrap={wrap || undefined} style={{ "--excerpt-number-width": `${width}ch` } as React.CSSProperties}>
      {plain.slice(start - 1, end).map((line, index) => (
        <div key={start + index} className="code-excerpt-line">
          <span className="code-excerpt-number" aria-hidden="true">
            {start + index}
          </span>
          <code>
            {lines?.[start - 1 + index]?.map((token, at) =>
              token.classes ? (
                <span key={at} className={token.classes}>
                  {token.text}
                </span>
              ) : (
                token.text
              ),
            ) ?? line}
          </code>
        </div>
      ))}
    </pre>
  );
}
