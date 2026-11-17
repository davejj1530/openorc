// @vitest-environment jsdom
import type { TeamChatListRow } from "@openorc/client";
import type { TeamConversation } from "@openorc/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ConversationFace } from "./ChatFace";

afterEach(cleanup);

const RILEY = { id: "u-riley", name: "Riley Chen", image: null };
const MARA = { id: "u-mara", name: "Mara Okafor", image: null };
const THEO = { id: "u-theo", name: "Theo Laurent", image: null };
const online = new Map([
  ["u-mara", "connected"],
  ["u-theo", "connected"],
]);
const conversation = (more: Partial<TeamConversation>) => ({ id: "c1", kind: "group", participants: [RILEY, MARA, THEO].map((person) => ({ person })), ...more }) as unknown as TeamConversation;
const row = (more: Partial<TeamChatListRow>) => ({ id: "r1", title: "", unread: 0, mentioned: false, ...more }) as TeamChatListRow;

it("dots a person while one of their OpenOrc apps is connected, and no one it does not know of", () => {
  render(<ConversationFace row={row({ kind: "person", person: MARA, conversation: null })} self={RILEY.id} presence={online} />);
  expect(screen.getByLabelText("Connected to OpenOrc")).toBeTruthy();
  cleanup();
  render(<ConversationFace row={row({ kind: "person", person: MARA, conversation: null })} self={RILEY.id} presence={new Map()} />);
  expect(screen.queryByLabelText("Connected to OpenOrc")).toBeNull();
});

it("draws a group as its others' two faces, without dots, and a channel as its #", () => {
  const { container } = render(<ConversationFace row={row({ kind: "conversation", conversation: conversation({}) })} self={RILEY.id} presence={online} />);
  expect(container.textContent).toBe("MOTL");
  expect(screen.queryByLabelText("Connected to OpenOrc")).toBeNull();
  cleanup();
  const channel = render(<ConversationFace row={row({ kind: "conversation", conversation: conversation({ kind: "channel" }) })} self={RILEY.id} presence={online} />);
  expect(channel.container.textContent).toBe("#");
});
