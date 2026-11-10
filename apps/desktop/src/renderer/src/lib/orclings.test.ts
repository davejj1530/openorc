import { expect, it } from "vitest";
import { defaultOrclingLook, type Orcling, type OrclingGroup } from "@openorc/protocol";
import { afterOrclingDeleted, groupsGoingWith } from "./orclings";

const orcling = (id: string) => ({ id, threadId: `${id}-chat`, name: id, look: defaultOrclingLook }) as Orcling;

it("lands on the chat below a deleted Orcling, the one above when it was last, and a new Orcling when none is left", () => {
  const list = [orcling("pip"), orcling("bo"), orcling("rini")];
  expect(afterOrclingDeleted(list, "bo")).toEqual({ view: "thread", threadId: "rini-chat" });
  expect(afterOrclingDeleted(list, "rini")).toEqual({ view: "thread", threadId: "bo-chat" });
  expect(afterOrclingDeleted([orcling("pip")], "pip")).toEqual({ view: "orcling" });
});

it("names the group chats a deleted Orcling takes with it: those with only one other Orcling, by that one", () => {
  const list = [orcling("pip"), orcling("bo"), orcling("rini")];
  const group = (threadId: string, memberIds: string[]) => ({ threadId, title: threadId, memberIds, createdAt: 0 }) as OrclingGroup;
  const groups = [group("pair", ["pip", "bo"]), group("trio", ["pip", "bo", "rini"]), group("other", ["bo", "rini"])];
  expect(groupsGoingWith(groups, list, "pip")).toEqual(["bo"]);
  expect(groupsGoingWith(groups, list, "bo")).toEqual(["pip", "rini"]);
  expect(groupsGoingWith([groups[1]!], list, "pip")).toEqual([]);
});
