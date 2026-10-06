import { useState } from "react";
import { Select, TextButton } from "../components/ui";
import { codeFonts, parseCodeFont, useCodeFont, type CodeFont } from "../lib/code-font";
import { Field, Section } from "./settings-shared";

export function CodeFontSettings({ report }: { report: (saved: boolean) => void }) {
  const { font, setFont } = useCodeFont();
  const [saved, setSaved] = useState(true);
  const choose = (next: CodeFont): void => {
    const success = setFont(next);
    setSaved(success);
    report(success);
  };
  return (
    <Section title="Code font" description="For code blocks, diffs, and terminals.">
      <Field label="Typeface">
        <Select aria-label="Code font" value={font} onChange={(event) => choose(parseCodeFont(event.target.value))}>
          {codeFonts.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Select>
      </Field>
      <pre className="code-font-preview" tabIndex={0} aria-label="Code font preview">
        <code>
          <span className="text-ink-3">{"// Preview: 0O 1Il {} [] =>\n"}</span>
          {"const greeting = 'Hello, world!';\nfunction sum(a, b) {\n  return a + b;\n}"}
        </code>
      </pre>
      {!saved && (
        <TextButton className="mt-2" onClick={() => choose(font)}>
          Retry save
        </TextButton>
      )}
    </Section>
  );
}
