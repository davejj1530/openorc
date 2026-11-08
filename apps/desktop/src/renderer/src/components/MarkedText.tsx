import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import { createContext, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent, type RefObject } from "react";
import { skillNames, skillSegments } from "@openorc/client";
import type { UsableConnector } from "@openorc/protocol";
import { connectorSpans, type ConnectorMentions } from "../lib/connector-mentions";
import { floatingGround } from "../lib/use-anchor-ground";
import { ConnectorLogo } from "./ConnectorLogo";

/** What a message's words may name: the agent's skills, and the connectors `@` can name. */
export interface MarkSources {
  commands?:
    readonly { name: string; hint: string; insert?: boolean; prefix?: "/" | "$"; aliases?: readonly string[] | undefined; displayName?: string | undefined; icon?: string | undefined }[] | undefined;
  connectors?: readonly UsableConnector[] | undefined;
}

/** The skills and connectors a conversation's messages are drawn with, for the messages deep in its transcript. */
export const MessageMarks = createContext<MarkSources>({});

/**
 * A conversation's marks for its messages: its skills, and every connector its messages may name, the ones the agent
 * goes without in this mode too, since a message sent earlier may name one. Connectors come from a list already read;
 * showing a message never reads it, since reading starts the agents' servers.
 */
export function useMessageMarks(commands: MarkSources["commands"], mentions: ConnectorMentions) {
  const { connectors, connectorsAside } = mentions;
  return useMemo(() => ({ commands, connectors: [...connectors, ...(connectorsAside?.connectors ?? [])] }), [commands, connectors, connectorsAside]);
}

/** Text with each connector's `@` drawn as its image, within the width of the `@`, so the letters after it keep their places. */
function ConnectorText({ text, connectors }: { text: string; connectors: readonly UsableConnector[] }) {
  return connectorSpans(text, [...connectors]).map((span, index) =>
    span.connector ? (
      <mark key={index} className="connector-token">
        <span
          className="connector-token-at"
          style={span.connector.logo ? ({ "--token-logo": `url("${span.connector.logo}")` } as CSSProperties) : undefined}
          data-letter={span.connector.logo ? undefined : span.connector.title.slice(0, 1).toUpperCase()}
        >
          @
        </span>
        {span.text.slice(1)}
      </mark>
    ) : (
      <span key={index}>{span.text}</span>
    ),
  );
}

/**
 * A message's words as the composer draws them: each skill it names in blue, at the regular letters' width, and each
 * connector's `@` as its image. The composer lays this under its textarea; a sent message shows it as it is.
 */
export function MarkedText({ text, commands, connectors }: { text: string } & MarkSources) {
  const names = useMemo(() => skillNames(commands ?? []), [commands]);
  const prefix = commands?.find((command) => command.insert)?.prefix ?? "/";
  const segments = useMemo(() => skillSegments(text, names, prefix), [text, names, prefix]);
  return segments.map((segment, index) =>
    segment.skill ? (
      <mark key={index} className="skill-token" data-skill={segment.text.slice(1)}>
        {segment.text}
      </mark>
    ) : (
      <ConnectorText key={index} text={segment.text} connectors={connectors ?? []} />
    ),
  );
}

/** How long the pointer rests on a skill before it says what it is for. */
const HOVER_MS = 350;

/**
 * The skill mark under the pointer in `marks`, found by where the marks are drawn, since in the composer the textarea
 * over them takes the pointer. Spread the handlers on the element the pointer moves over.
 */
export function useSkillHover(marks: RefObject<HTMLElement | null>) {
  const [hovered, setHovered] = useState<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<HTMLElement | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const settle = (mark: HTMLElement | null) => {
    if (mark === pending.current) return;
    pending.current = mark;
    if (timer.current) clearTimeout(timer.current);
    if (!mark) return setHovered(null);
    timer.current = setTimeout(() => setHovered(mark), HOVER_MS);
  };
  const onPointerMove = (event: PointerEvent) => {
    const inside = (rect: DOMRect) => event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    const found = [...(marks.current?.querySelectorAll<HTMLElement>("[data-skill]") ?? [])].find((mark) => [...mark.getClientRects()].some(inside));
    settle(found ?? null);
  };
  // Typing redraws the marks; a mark that is gone says nothing until the pointer moves onto its successor.
  return { hovered: hovered?.isConnected ? hovered : null, onPointerMove, onPointerLeave: () => settle(null) };
}

/** What the skill under the pointer is for, over its mark: its image and name over the call that runs it, then what it does. */
export function SkillHoverCard({ mark, commands }: { mark: HTMLElement | null } & Pick<MarkSources, "commands">) {
  const name = mark?.dataset["skill"] ?? "";
  const skill = commands?.find((command) => command.insert && (command.name === name || command.aliases?.includes(name)));
  const title = skill?.displayName ?? skill?.name ?? "";
  return (
    <BaseTooltip.Root open={Boolean(mark && skill)}>
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner anchor={mark} side="top" sideOffset={6} collisionPadding={8}>
          <BaseTooltip.Popup ref={floatingGround} className="tooltip-popup skill-hover">
            <span className="skill-hover-head">
              <span className="logo-badge skill-hover-mark">
                <ConnectorLogo title={title} logo={skill?.icon ?? null} size={22} />
              </span>
              <span className="skill-hover-title">
                <span className="skill-hover-name">{title}</span>
                <span className="skill-hover-call">
                  {skill?.prefix ?? "/"}
                  {skill?.name}
                </span>
              </span>
            </span>
            {skill?.hint ? <span className="skill-hover-hint">{skill.hint}</span> : null}
          </BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}
