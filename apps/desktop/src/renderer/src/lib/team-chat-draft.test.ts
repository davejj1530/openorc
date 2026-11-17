import { expect, it } from "vitest";
import { TeamChatDrafts } from "./team-chat-draft";

const scope = { accountId: "first", spaceId: "team", conversationId: "general" };
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}
it("keeps drafts separate by account, organization and conversation after relaunch", () => {
  const disk = storage();
  const drafts = new TeamChatDrafts(disk);
  drafts.write(scope, "A draft worth keeping");
  const again = new TeamChatDrafts(disk);
  expect(again.read(scope).text).toBe("A draft worth keeping");
  expect(again.read({ ...scope, accountId: "second" }).text).toBe("");
  expect(again.read({ ...scope, spaceId: "other-team" }).text).toBe("");
  expect(again.read({ ...scope, conversationId: "direct" }).text).toBe("");
});
it("retains a stable send ID through an unconfirmed delivery and relaunch", () => {
  const disk = storage();
  const drafts = new TeamChatDrafts(disk);
  drafts.write(scope, "Ready for review");
  const pending = drafts.begin(scope);
  expect(pending?.body).toBe("Ready for review");
  const again = new TeamChatDrafts(disk);
  expect(again.read(scope)).toMatchObject({ text: "", pending: [{ id: pending?.id, body: "Ready for review", state: "failed" }] });
  again.reconcile(scope, [pending?.id ?? ""]);
  expect(again.read(scope).pending).toEqual([]);
});
it("keeps the message a draft answers through relaunch, sends it with the words once, then answers none", () => {
  const disk = storage();
  const drafts = new TeamChatDrafts(disk);
  const answered = { id: "question", seq: 4, person: { id: "mara", name: "Mara Okafor", image: null }, orcling: null, excerpt: "Is the build green?", files: 0 };
  drafts.reply(scope, answered);
  drafts.write(scope, "Yes");
  const again = new TeamChatDrafts(disk);
  expect(again.read(scope).replyTo).toEqual(answered);
  expect(again.begin(scope)).toMatchObject({ body: "Yes", replyTo: answered });
  expect(again.read(scope).replyTo).toBeNull();
  expect(new TeamChatDrafts(disk).read(scope).pending[0]?.replyTo).toEqual(answered);
});
it("drops only the inaccessible chat on removal, keeping another chat and account", () => {
  const drafts = new TeamChatDrafts(storage());
  const other = { ...scope, conversationId: "other" };
  const second = { ...scope, accountId: "second" };
  for (const at of [scope, other, second]) drafts.write(at, "Kept");
  drafts.forget(scope);
  expect(drafts.read(scope).text).toBe("");
  expect(drafts.read(other).text).toBe("Kept");
  drafts.forgetSpace(scope.accountId, scope.spaceId);
  expect(drafts.read(other).text).toBe("");
  expect(drafts.read(second).text).toBe("Kept");
});
it("cannot restore removed words when browser storage refuses deletion", () => {
  const disk = storage();
  const drafts = new TeamChatDrafts({
    ...disk,
    removeItem: () => {
      throw new Error("Unavailable");
    },
  });
  drafts.write(scope, "Private words");
  drafts.forget(scope);
  expect(drafts.read(scope)).toEqual({ text: "", replyTo: null, orcling: null, pending: [] });
  drafts.write(scope, "New words");
  drafts.forgetSpace(scope.accountId, scope.spaceId);
  expect(drafts.read(scope)).toEqual({ text: "", replyTo: null, orcling: null, pending: [] });
});
