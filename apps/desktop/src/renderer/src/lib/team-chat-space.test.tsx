import { expect, it } from "vitest";
import { validSpaceView, type SpaceInventory } from "./space-view";

const chat = { view: "team-chat", accountId: "first", spaceId: "team", conversationId: "general" };
const inventory: SpaceInventory = { id: "team", accountId: "first", personal: false, projects: [], threads: [], taskIds: [] };
const saved = { destination: chat, tabs: [{ id: "chat-tab", route: chat }], activeTab: "chat-tab" };
it("restores only this account's organization chat tab and destination", () => {
  expect(validSpaceView(saved, inventory)).toMatchObject(saved);
  for (const space of [
    { ...inventory, accountId: "second" },
    { ...inventory, personal: true },
    { ...inventory, id: "another" },
  ]) {
    expect(validSpaceView(saved, space)).toMatchObject({ destination: { view: "newthread" }, tabs: [] });
  }
});
it("removes unknown fields and incomplete chat identities before restoring", () => {
  expect(validSpaceView({ ...saved, destination: { ...chat, token: "discard" } }, inventory).destination).toEqual(chat);
  expect(validSpaceView({ ...saved, destination: { ...chat, conversationId: "" } }, inventory).destination).toEqual({ view: "newthread" });
});
