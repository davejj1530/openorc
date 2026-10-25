import { fromBase64Url, pushKeys, sealPush, type PushEnvelope, type PushNotice } from "@openorc/link";
import { nodeCrypto } from "@openorc/link/node";
import vectorFile from "@openorc/link/test-fixtures/push-vectors.json" with { type: "json" };
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const target = resolve(import.meta.dirname, "../../targets/notification-service");
const sources = [join(target, "PushOpener.swift"), join(target, "NotificationService.swift"), resolve(import.meta.dirname, "main.swift")];

type Key = "found" | "missing" | "locked";
interface Shown {
  name: string;
  title: string;
  subtitle: string;
  body: string;
  threadIdentifier: string;
  categoryIdentifier: string;
  userInfo: Record<string, unknown>;
  asked: string[];
}

const mac = nodeCrypto.keyPairFromPrivate(fromBase64Url(vectorFile.mac.privateKey));
const phonePublic = fromBase64Url(vectorFile.phone.publicKey);
const macId = vectorFile.mac.publicKey;
const outer = (envelope: unknown) => ({ aps: { alert: { body: "New activity on your Mac" }, "mutable-content": 1 }, o: envelope });
const vector = (list: { name: string; envelope: unknown }[], name: string) => list.find((item) => item.name === name)!.envelope;
const sealed = (notice: PushNotice): PushEnvelope => sealPush(nodeCrypto, pushKeys(nodeCrypto, mac, phonePublic, "mac").seal, mac.publicKey, notice);
const unopenable = { tampered: "tampered ciphertext", "another Mac": "another Mac's m", "flipped nonce": "flipped nonce" };

let binary: string;

function show(cases: { name: string; userInfo: unknown; key: Key }[]): Map<string, Shown> {
  const input = { phoneKey: vectorFile.phone.privateKey, cases: cases.map((item) => ({ ...item, userInfo: JSON.stringify(item.userInfo) })) };
  const shown = JSON.parse(execFileSync(binary, { input: JSON.stringify(input) }).toString("utf8")) as Shown[];
  return new Map(shown.map((item) => [item.name, item]));
}

// macOS has UserNotifications, CryptoKit and Security, so the extension's own files run here as on the phone. A Mac
// without swiftc fails.
describe.runIf(process.platform === "darwin")("the notification service extension", () => {
  beforeAll(() => {
    const dir = mkdtempSync(join(tmpdir(), "openorc-notification-service-"));
    binary = join(dir, "reveal");
    execFileSync("swiftc", [...sources, "-o", binary], { stdio: "pipe" });
    return () => rmSync(dir, { recursive: true, force: true });
  }, 180_000);

  it("shows what the Mac sealed, with only ids left for the app to route a tap", () => {
    const shown = show([
      { name: "approval", userInfo: outer(vector(vectorFile.good, "approval with ids")), key: "found" },
      { name: "finished", userInfo: outer(vector(vectorFile.good, "finished turn")), key: "found" },
      { name: "test", userInfo: outer(vector(vectorFile.good, "test notice")), key: "found" },
    ]);
    expect(shown.get("approval")).toEqual({
      name: "approval",
      title: "Approve a command",
      subtitle: "",
      body: "git push origin main",
      threadIdentifier: "thread-1",
      categoryIdentifier: "approval",
      userInfo: {
        body: { macId, id: "notice-1", kind: "approval", threadId: "thread-1", runId: "run-1", approvalId: "approval-1", o: vector(vectorFile.good, "approval with ids") },
      },
      asked: [macId],
    });
    const finished = vectorFile.good.find((item) => item.name === "finished turn")!.notice;
    expect(shown.get("finished")).toMatchObject({ title: finished.title, body: finished.body, threadIdentifier: finished.threadId, categoryIdentifier: "" });
    expect(shown.get("finished")!.userInfo).toEqual({ body: { macId, id: finished.id, kind: "finished", threadId: finished.threadId, o: vector(vectorFile.good, "finished turn") } });
    const test = vectorFile.good.find((item) => item.name === "test notice")!.notice;
    expect(shown.get("test")).toMatchObject({ title: test.title, body: test.body, threadIdentifier: "", categoryIdentifier: "" });
    expect(shown.get("test")!.userInfo).toEqual({ body: { macId, id: test.id, kind: "test", o: vector(vectorFile.good, "test notice") } });
  });

  it("opens a reply the Mac cut through an emoji, half of it left alone", () => {
    const cut = `${"a".repeat(139)}🚀`.slice(0, 140);
    const shown = show([
      { name: "vector", userInfo: outer(vector(vectorFile.good, "a lone surrogate where a cut split an emoji")), key: "found" },
      { name: "cut reply", userInfo: outer(sealed({ id: "cut", kind: "finished", threadId: "thread-5", title: "Release 🚀".slice(0, 9), body: cut })), key: "found" },
    ]);
    expect(shown.get("vector")).toMatchObject({ title: "Launch �", body: "Shipped �", threadIdentifier: "thread-5" });
    expect(shown.get("cut reply")).toMatchObject({ title: "Release �", body: `${"a".repeat(139)}�`, threadIdentifier: "thread-5" });
    expect(shown.get("cut reply")!.userInfo).toMatchObject({ body: { macId, id: "cut", kind: "finished", threadId: "thread-5" } });
  });

  it("offers Allow and Deny only on an approval that carries both ids", () => {
    const base = { threadId: "thread-1", title: "Studio", body: "Codex wants to run ls" };
    const shown = show([
      { name: "no ids", userInfo: outer(sealed({ ...base, id: "a", kind: "approval" })), key: "found" },
      { name: "question", userInfo: outer(sealed({ ...base, id: "q", kind: "question", approval: { runId: "run-1", approvalId: "approval-1" } })), key: "found" },
    ]);
    expect(shown.get("no ids")).toMatchObject({ body: base.body, categoryIdentifier: "" });
    expect(shown.get("question")).toMatchObject({ body: base.body, categoryIdentifier: "" });
    expect(shown.get("question")!.userInfo).toMatchObject({ body: { macId, id: "q", kind: "question", threadId: "thread-1", runId: "run-1", approvalId: "approval-1" } });
  });

  it("keeps the outer text, or says why, with no actions and nothing to route, whenever it cannot open the alert", () => {
    const approval = outer(vector(vectorFile.good, "approval with ids"));
    const shown = show([
      { name: "forgotten Mac", userInfo: approval, key: "missing" },
      { name: "before first unlock", userInfo: approval, key: "locked" },
      { name: "newer scheme", userInfo: outer(vector(vectorFile.bad, "unknown version")), key: "found" },
      ...Object.entries(unopenable).map(([name, bad]) => ({ name, userInfo: outer(vector(vectorFile.bad, bad)), key: "found" as const })),
      { name: "not ours", userInfo: { aps: { alert: { body: "New activity on your Mac" } } }, key: "found" },
    ]);
    const plain = (name: string, body: string) =>
      expect(shown.get(name)).toEqual({ name, title: "", subtitle: "", body, threadIdentifier: "", categoryIdentifier: "", userInfo: {}, asked: shown.get(name)!.asked });
    plain("forgotten Mac", "From a Mac this iPhone no longer pairs with.");
    plain("newer scheme", "Update OpenOrc on this iPhone to read this.");
    for (const name of ["before first unlock", ...Object.keys(unopenable), "not ours"]) plain(name, "New activity on your Mac");
    expect(shown.get("newer scheme")!.asked).toEqual([]);
    expect(shown.get("not ours")!.asked).toEqual([]);
  });

  it("drops the actions, thread and route a push asks for beside a notice it cannot open, and keeps only a sealed notice's, with its own text alone", () => {
    const route = { macId, id: "forged", kind: "approval", threadId: "thread-1", runId: "run-1", approvalId: "0" };
    const alert = { body: "New activity on your Mac", subtitle: "Safe: only reads files, Allow is fine" };
    const forged = (o: unknown) => ({ aps: { alert, "mutable-content": 1, category: "approval", "thread-id": "thread-1" }, body: route, ...(o ? { o } : {}) });
    const recorded = vector(vectorFile.good, "approval with ids");
    const shown = show([
      { name: "no notice", userInfo: forged(null), key: "found" },
      { name: "tampered notice", userInfo: forged(vector(vectorFile.bad, "tampered ciphertext")), key: "found" },
      { name: "before first unlock", userInfo: forged(recorded), key: "locked" },
      { name: "forgotten Mac", userInfo: forged(recorded), key: "missing" },
      { name: "recorded notice", userInfo: forged(recorded), key: "found" },
    ]);
    for (const name of ["no notice", "tampered notice", "before first unlock", "forgotten Mac"]) {
      expect([name, shown.get(name)!.categoryIdentifier, shown.get(name)!.threadIdentifier, shown.get(name)!.userInfo]).toEqual([name, "", "", {}]);
    }
    expect(shown.get("recorded notice")).toMatchObject({
      title: "Approve a command",
      subtitle: "",
      body: "git push origin main",
      categoryIdentifier: "approval",
      userInfo: { body: { macId, id: "notice-1", kind: "approval", threadId: "thread-1", runId: "run-1", approvalId: "approval-1", o: recorded } },
    });
  });
});
