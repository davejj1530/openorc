import { $applyNodeReplacement, DecoratorNode, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread } from "lexical";
import type { ReactNode } from "react";
import type { Mark, MarkKind, Piece } from "../../lib/message-marks";
import { MessageMark } from "../MessageMark";

type SerializedMark = Spread<{ text: string; mark: Mark }, SerializedLexicalNode>;

/**
 * A mark in the draft, standing for the words it was read from, which is all the message carries in its place. It is
 * one piece: Backspace takes it whole, the arrows step over it, a copy takes its words, and Undo puts it back. It
 * draws with the sent message's own mark, so how a kind looks is changed in one place.
 */
abstract class MarkNode<K extends MarkKind> extends DecoratorNode<ReactNode> {
  __text: string;
  __mark: Extract<Mark, { kind: K }>;

  constructor(text: string, mark: Extract<Mark, { kind: K }>, key?: NodeKey) {
    super(key);
    this.__text = text;
    this.__mark = mark;
  }

  piece(): Piece {
    return { text: this.__text, mark: this.__mark };
  }

  override exportJSON(): SerializedMark {
    return { ...super.exportJSON(), text: this.__text, mark: this.__mark };
  }

  override createDOM(): HTMLElement {
    return document.createElement("span");
  }

  override updateDOM(): false {
    return false;
  }

  override isInline(): true {
    return true;
  }

  // Backspace beside a mark takes it at once, rather than first selecting it.
  override isKeyboardSelectable(): false {
    return false;
  }

  override getTextContent(): string {
    return this.__text;
  }

  override decorate(): ReactNode {
    return <MessageMark text={this.__text} mark={this.__mark} />;
  }
}

/** A skill the agent will run, as `/name` or `$name`. */
export class SkillNode extends MarkNode<"skill"> {
  static override getType() {
    return "composer-skill";
  }
  static override clone(node: SkillNode) {
    return new SkillNode(node.__text, node.__mark, node.__key);
  }
  static override importJSON(json: SerializedMark) {
    return $applyNodeReplacement(new SkillNode(json.text, json.mark as Extract<Mark, { kind: "skill" }>));
  }
  constructor(text = "", mark: Extract<Mark, { kind: "skill" }> = { kind: "skill", name: "" }, key?: NodeKey) {
    super(text, mark, key);
  }
}

/** A connector named with `@name`, drawn with its image. */
export class ConnectorNode extends MarkNode<"connector"> {
  static override getType() {
    return "composer-connector";
  }
  static override clone(node: ConnectorNode) {
    return new ConnectorNode(node.__text, node.__mark, node.__key);
  }
  static override importJSON(json: SerializedMark) {
    return $applyNodeReplacement(new ConnectorNode(json.text, json.mark as Extract<Mark, { kind: "connector" }>));
  }
  constructor(text = "", mark: Extract<Mark, { kind: "connector" }> = { kind: "connector", connector: { name: "", title: "", logo: null } }, key?: NodeKey) {
    super(text, mark, key);
  }
}

/** Someone `@` addresses, such as an Orcling. */
export class MemberNode extends MarkNode<"member"> {
  static override getType() {
    return "composer-member";
  }
  static override clone(node: MemberNode) {
    return new MemberNode(node.__text, node.__mark, node.__key);
  }
  static override importJSON(json: SerializedMark) {
    return $applyNodeReplacement(new MemberNode(json.text, json.mark as Extract<Mark, { kind: "member" }>));
  }
  constructor(text = "", mark: Extract<Mark, { kind: "member" }> = { kind: "member", key: "" }, key?: NodeKey) {
    super(text, mark, key);
  }
}

/** A file picked from the `@` list, sent as its path. */
export class FileNode extends MarkNode<"file"> {
  static override getType() {
    return "composer-file";
  }
  static override clone(node: FileNode) {
    return new FileNode(node.__text, node.__mark, node.__key);
  }
  static override importJSON(json: SerializedMark) {
    return $applyNodeReplacement(new FileNode(json.text, json.mark as Extract<Mark, { kind: "file" }>));
  }
  constructor(text = "", mark: Extract<Mark, { kind: "file" }> = { kind: "file", path: "" }, key?: NodeKey) {
    super(text, mark, key);
  }
}

/** Every node a composer draft holds besides words and line breaks. */
export const MARK_NODES = [SkillNode, ConnectorNode, MemberNode, FileNode];

/** The node for a marked run, of the class its kind names. */
export function $createMarkNode(text: string, mark: Mark): LexicalNode {
  switch (mark.kind) {
    case "skill":
      return $applyNodeReplacement(new SkillNode(text, mark));
    case "connector":
      return $applyNodeReplacement(new ConnectorNode(text, mark));
    case "member":
      return $applyNodeReplacement(new MemberNode(text, mark));
    case "file":
      return $applyNodeReplacement(new FileNode(text, mark));
  }
}

export const $isMarkNode = (node: LexicalNode | null | undefined): node is MarkNode<MarkKind> => node instanceof MarkNode;
