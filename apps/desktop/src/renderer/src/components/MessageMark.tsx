import type { CSSProperties } from "react";
import type { Mark } from "../lib/message-marks";

/**
 * How one mark is drawn, in the composer and in a sent message alike: a skill in blue, a connector with its image in
 * place of its `@` (within the `@`'s own width), and a member or a picked file as its words. Each kind draws only here.
 */
export function MessageMark({ text, mark }: { text: string; mark: Mark }) {
  switch (mark.kind) {
    case "skill":
      return (
        <mark className="skill-token" data-skill={mark.name}>
          {text}
        </mark>
      );
    case "connector": {
      const { logo, title } = mark.connector;
      return (
        <mark className="connector-token" data-connector={mark.connector.name}>
          <span className="connector-token-at" style={logo ? ({ "--token-logo": `url("${logo}")` } as CSSProperties) : undefined} data-letter={logo ? undefined : title.slice(0, 1).toUpperCase()}>
            @
          </span>
          {text.slice(1)}
        </mark>
      );
    }
    case "member":
      return <span data-member={mark.key}>{text}</span>;
    case "file":
      return <span data-file={mark.path}>{text}</span>;
  }
}
