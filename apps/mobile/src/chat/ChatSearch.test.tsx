// @vitest-environment jsdom
import type { TeamChatLease } from "@openorc/client";
import type { TeamChatSearch, TeamChatTimeline, TeamConversation } from "@openorc/protocol";
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatSearchHits } from "./ChatSearch";
import { useMessageReveal } from "./reveal";

const chat = vi.hoisted(() => ({ search: null as { data?: TeamChatSearch; error?: Error } | null, earlier: vi.fn(), push: vi.fn() }));
vi.mock("expo-router", () => ({ router: { push: chat.push } }));
vi.mock("../client", () => ({ teamChat: { useSearch: () => chat.search, earlier: chat.earlier } }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const lease = { accountId: "u-riley", spaceId: "org-birch", generation: 1, reach: "live", current: () => true } as TeamChatLease;
const MARA = { id: "u-mara", name: "Mara Okafor", image: null };
const launch = { id: "c-launch", kind: "channel", name: "launch", participants: [] } as unknown as TeamConversation;
const hit = (id: string, channelId: string, text: string) => ({ id, channelId, seq: 4, person: MARA, snippet: { text, marks: [] }, files: [], createdAt: new Date().toISOString() });

it("lists the messages that match where the reader may read them, and opens one at its message", () => {
  chat.search = { data: { hits: [hit("m4", "c-launch", "The pricing page still says beta"), hit("m9", "c-gone", "Elsewhere")], more: false } };
  render(<ChatSearchHits lease={lease} query="pricing" conversations={[launch]} />);
  const row = screen.getByRole("button");
  expect(row.getAttribute("aria-label")).toMatch(/^Mara Okafor: The pricing page still says beta, in #launch, /);
  fireEvent.click(row);
  expect(chat.push).toHaveBeenCalledWith({ pathname: "/chat/[id]", params: { id: "c-launch", message: "m4", seq: "4" } });
  cleanup();
  chat.search = { data: { hits: [], more: false } };
  render(<ChatSearchHits lease={lease} query="nothing" conversations={[launch]} />);
  expect(screen.getByText("No messages found")).toBeTruthy();
});

const page = (seqs: number[], older: boolean) => ({ messages: seqs.map((seq) => ({ id: `m${seq}`, seq })), older }) as unknown as TeamChatTimeline;

it("pages back until the message asked for is on the page, then names it; one no longer there ends quietly", async () => {
  chat.earlier.mockResolvedValue(undefined);
  const { result, rerender } = renderHook(({ timeline }) => useMessageReveal(lease, "c-launch", timeline, { id: "m4", seq: 4 }), { initialProps: { timeline: page([20, 21], true) } });
  expect(result.current).toBeNull();
  await waitFor(() => expect(chat.earlier).toHaveBeenCalledOnce());
  rerender({ timeline: page([4, 5, 20, 21], true) });
  expect(result.current).toBe("m4");
  expect(chat.earlier).toHaveBeenCalledOnce();
  chat.earlier.mockClear();
  // Deleted: paged past it, so nothing more is asked.
  rerender({ timeline: page([2, 5, 20], true) });
  expect(result.current).toBeNull();
  expect(chat.earlier).not.toHaveBeenCalled();
});
