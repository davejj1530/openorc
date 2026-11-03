import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { settings, threads } from "@openorc/db";
import { commitAll, git } from "@openorc/git";
import { FolderPath, type FileScope, type Project } from "@openorc/protocol";
import { OpenOrc } from "./openorc.js";
import { rpcClient } from "./rpc-test-client.js";
import type { Completion } from "./services/text-generation.js";

let root: string;
let checkout: string;
let core: OpenOrc;
let project: Project;
let scope: FileScope;
const cart = "export function cartTotal(items: number[]) {\n  return items.reduce((sum, item) => sum + item, 0);\n}\n";
const path = FolderPath.parse("cart.ts");
const call = rpcClient(() => core);
const complete = vi.fn<OpenOrc["textGeneration"]["complete"]>();
const answered = (value: unknown): Completion => ({ kind: "answered", text: JSON.stringify(value), model: { provider: "claude", label: "Claude Haiku 4.5" } });
const walkthrough = { overview: "Adds up a cart.", blocks: [{ start: 1, end: 3, title: "Cart total", explanation: "Sums the prices.", symbols: ["cartTotal"] }] };

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "openorc-explain-rpc-")));
  checkout = join(root, "checkout");
  await mkdir(join(checkout, "src"), { recursive: true });
  await git(checkout, ["init", "-q", "-b", "main"]);
  await git(checkout, ["config", "user.email", "fixture@example.invalid"]);
  await git(checkout, ["config", "user.name", "Fixture"]);
  await Promise.all([
    writeFile(join(checkout, path), cart),
    writeFile(join(checkout, "src/checkout.ts"), 'import { cartTotal } from "../cart";\nexport const due = cartTotal([1, 2]);\n'),
    writeFile(join(checkout, "src/other.ts"), "export const cartTotals = 3;\n"),
  ]);
  await commitAll(checkout, "Fixture");
  core = await OpenOrc.create({ dataDir: join(root, "data"), ephemeral: true, transport: { push() {} } });
  settings.set(core.db, "extraction.provider", "off");
  project = await core.projects.import(checkout);
  const thread = threads.insert(core.db, { projectId: project.id, title: "Cart", agent: "codex", model: null, mode: "act", permissionMode: "trusted" });
  scope = { kind: "thread", id: thread.id };
  complete.mockReset();
  vi.spyOn(core.textGeneration, "complete").mockImplementation(complete);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await core.close();
  await rm(root, { recursive: true, force: true });
});

it("explains with the conversation's own agent, keeps the answer for the same text, and asks again only on refresh or new text", async () => {
  complete.mockResolvedValue(answered({ markdown: "Adds up a cart." }));
  const first = await call("code.explain", { scope, path, text: cart, view: "english" });
  expect(first).toMatchObject({ kind: "explained", explanation: { view: "english", markdown: "Adds up a cart." }, model: { label: "Claude Haiku 4.5" } });
  expect(complete).toHaveBeenCalledTimes(1);
  expect(complete.mock.calls[0]?.[0]).toMatchObject({ agent: "codex" });
  expect(complete.mock.calls[0]?.[0].prompt).toContain("1| export function cartTotal(items: number[]) {");

  expect(await call("code.explain", { scope, path, text: cart, view: "english" })).toEqual(first);
  expect(complete).toHaveBeenCalledTimes(1);
  await call("code.explain", { scope, path, text: cart, view: "english", refresh: true });
  await call("code.explain", { scope, path, text: `${cart}// changed\n`, view: "english" });
  expect(complete).toHaveBeenCalledTimes(3);
  expect(await readdir(join(root, "data", "code-explanations"))).toHaveLength(2);
});

it("asks once for two requests that arrive together", async () => {
  let answer!: (value: Completion) => void;
  complete.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  const both = Promise.all([call("code.explain", { scope, path, text: cart, view: "english" }), call("code.explain", { scope, path, text: cart, view: "english" })]);
  await vi.waitFor(() => expect(complete).toHaveBeenCalled());
  answer(answered({ markdown: "Adds up a cart." }));
  const [first, second] = await both;
  expect(first).toEqual(second);
  expect(complete).toHaveBeenCalledTimes(1);
});

it("says who uses each block from the files that name it, never the file itself or a longer name", async () => {
  complete.mockResolvedValue(answered(walkthrough));
  const result = await call("code.explain", { scope, path, text: cart, view: "walkthrough" });
  expect(result).toMatchObject({ kind: "explained", explanation: { view: "walkthrough", overview: "Adds up a cart." } });
  const usedBy = result.kind === "explained" && result.explanation.view === "walkthrough" ? result.explanation.blocks[0]?.usedBy : null;
  expect(usedBy).toEqual([{ path: "src/checkout.ts", line: 1, text: 'import { cartTotal } from "../cart";' }]);

  await writeFile(join(checkout, "src/summary.ts"), 'import { cartTotal } from "../cart";\n');
  const again = await call("code.explain", { scope, path, text: cart, view: "walkthrough" });
  expect(complete).toHaveBeenCalledTimes(1);
  expect(again.kind === "explained" && again.explanation.view === "walkthrough" && again.explanation.blocks[0]?.usedBy.map((usage) => usage.path)).toEqual(["src/checkout.ts", "src/summary.ts"]);
});

it("looks up callers for two explanations of one file at once without either stopping the other's", async () => {
  complete.mockResolvedValue(answered(walkthrough));
  const both = await Promise.all([call("code.explain", { scope, path, text: cart, view: "walkthrough" }), call("code.explain", { scope, path, text: cart, view: "walkthrough", refresh: true })]);
  for (const result of both)
    expect(result.kind === "explained" && result.explanation.view === "walkthrough" && result.explanation.blocks[0]?.usedBy.map((usage) => usage.path)).toEqual(["src/checkout.ts"]);
});

it("explains a project's file before any conversation with the default harness", async () => {
  complete.mockResolvedValue(answered({ markdown: "Adds up a cart." }));
  await call("code.explain", { scope: { kind: "project", id: project.id }, path, text: cart, view: "english" });
  expect(complete.mock.calls[0]?.[0]).toMatchObject({ agent: "codex" });
  expect(complete.mock.calls[0]?.[0]).not.toHaveProperty("claudeAccountId");
});

it("answers why it can't explain without asking the model, and passes on why the model can't be asked", async () => {
  expect(await call("code.explain", { scope, path, text: "  \n", view: "english" })).toEqual({ kind: "unavailable", reason: "This file is empty.", settings: false });
  const long = Array.from({ length: 2_001 }, (_, index) => `const v${index} = ${index};`).join("\n");
  expect(await call("code.explain", { scope, path, text: long, view: "diagram" })).toEqual({
    kind: "unavailable",
    reason: "Explanations cover files up to 2,000 lines. This one has 2,001.",
    settings: false,
  });
  expect(complete).not.toHaveBeenCalled();

  complete.mockResolvedValueOnce({ kind: "unavailable", reason: "Text generation is off. Turn it on in Settings." });
  expect(await call("code.explain", { scope, path, text: cart, view: "english" })).toEqual({ kind: "unavailable", reason: "Text generation is off. Turn it on in Settings.", settings: true });
  complete.mockResolvedValueOnce(answered({ nothing: true }));
  expect(await call("code.explain", { scope, path, text: cart, view: "english" })).toEqual({ kind: "failed", reason: "The model didn't return a usable explanation. Try again." });
  expect(await readdir(join(root, "data")).then((names) => names.includes("code-explanations"))).toBe(false);
});
