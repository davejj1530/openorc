// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { PhoneSpaces } from "../spaces/use-spaces";
import { useChatLease } from "./lease";
import { homeTabs } from "../home/BottomBar";

const spaces = vi.hoisted(() => ({ now: { state: "none" } as PhoneSpaces }));
vi.mock("../spaces/use-spaces", () => ({ useSpaces: () => spaces.now }));

const personal = { id: "personal-me", kind: "personal" } as const;
const org = (id: string, name: string) => ({ id, kind: "organization", name, logo: null, memberId: "m", role: "member", memberCount: 2 }) as const;
const ready = (current: Extract<PhoneSpaces, { state: "ready" }>["current"], offline = false): PhoneSpaces => ({
  state: "ready",
  spaces: [personal, current],
  current,
  access: null,
  offline,
  userId: "u-riley",
});

it("leases the shown organization's chat, a new generation for another one, and nothing for Personal", () => {
  spaces.now = ready(org("org-birch", "Birch Studio"));
  const { result, rerender } = renderHook(() => useChatLease());
  const birch = result.current!;
  expect(birch).toMatchObject({ accountId: "u-riley", spaceId: "org-birch", reach: "live" });
  expect(birch.current()).toBe(true);
  spaces.now = ready(org("org-alder", "Alder Works"), true);
  rerender();
  expect(result.current).toMatchObject({ spaceId: "org-alder", reach: "offline" });
  expect(result.current!.generation).toBeGreaterThan(birch.generation);
  // What the Birch lease read no longer counts.
  expect(birch.current()).toBe(false);
  spaces.now = ready(personal);
  rerender();
  expect(result.current).toBeNull();
});

it("puts Chat beside Threads where an organization has it", () => {
  expect(homeTabs({ orclings: false, tasks: false, chat: true })).toEqual(["threads", "chat"]);
  expect(homeTabs({ orclings: true, tasks: true })).toEqual(["threads", "orclings", "tasks"]);
});
