import type { ReactNode } from "react";
import type { Mark } from "../lib/message-marks";
import { orclingById, useOrclings } from "../lib/orclings";
import { ConnectorLogo } from "./ConnectorLogo";
import { FileText } from "./icons";
import { OrclingAvatar } from "./OrclingAvatar";

/** A mark's size inside a pill: a hair under the words beside it. */
const MARK_SIZE = 13;

/**
 * How one mark is drawn, in the composer and in a sent message alike: a skill as blue words, and a file, an Orcling and
 * a connector as a pill of its mark and its name. The message keeps the words the mark stands for (the path, `@Rini`,
 * `@paper`); the pill shows only what a person reads them as. Each kind draws only here.
 */
export function MessageMark({ text, mark }: { text: string; mark: Mark }) {
  switch (mark.kind) {
    case "skill":
      return (
        <mark className="skill-token" data-skill={mark.name}>
          {text}
        </mark>
      );
    case "connector":
      return (
        <MarkPill data={{ "data-connector": mark.connector.name }} glyph={<ConnectorLogo title={mark.connector.title} logo={mark.connector.logo} size={MARK_SIZE} />}>
          {mark.connector.title}
        </MarkPill>
      );
    case "member":
      return <MemberPill text={text} memberKey={mark.key} />;
    case "person":
      return (
        <mark className="person-token" data-person={mark.id}>
          @{mark.name}
        </mark>
      );
    case "file":
      return (
        <MarkPill data={{ "data-file": mark.path }} glyph={<FileText size={MARK_SIZE} />}>
          {mark.path.split(/[\\/]/).pop() || mark.path}
        </MarkPill>
      );
  }
}

/** Someone `@` addresses: an Orcling by its face and name. */
function MemberPill({ text, memberKey }: { text: string; memberKey: string }) {
  const orcling = orclingById(useOrclings(), memberKey.replace(/^orcling:/, ""));
  return (
    <MarkPill data={{ "data-member": memberKey }} glyph={orcling ? <OrclingAvatar orcling={orcling} size={MARK_SIZE} /> : null}>
      {orcling?.name ?? text.replace(/^@/, "")}
    </MarkPill>
  );
}

function MarkPill({ data, glyph, children }: { data: Record<`data-${string}`, string>; glyph: ReactNode; children: ReactNode }) {
  return (
    <mark className="mark-pill" {...data}>
      {glyph}
      <span className="mark-pill-name">{children}</span>
    </mark>
  );
}
