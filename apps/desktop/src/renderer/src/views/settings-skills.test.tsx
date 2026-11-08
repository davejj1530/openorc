import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentSkill, FileVersion, Project, RpcMethod, RpcParams, RpcResults, SkillFileRead } from "@openorc/protocol";
import type { CodeEditorProps } from "../components/code-editor";
import { queryClient } from "../lib/client";
import { core } from "../lib/rpc";
import { SkillsSettings } from "./settings-skills";

vi.mock("../components/code-editor", () => ({
  CodeEditor: ({ text, readOnly, onChange }: CodeEditorProps) => <textarea aria-label="Editor" readOnly={readOnly} value={text} onChange={(event) => onChange(event.target.value)} />,
  closeEditorSession: () => {},
}));

const home = "/Users/me/.agents/skills";
const skill = (name: string, extra: Partial<AgentSkill> = {}): AgentSkill => ({ name, description: `${name} described`, source: "user", path: `${home}/${name}/SKILL.md`, ...extra });
const research = skill("research", { displayName: "Research", shortDescription: "Research from high-trust sources", enabled: true, editable: true, icon: "data:image/png;base64,AAAA" });
const deslop = skill("deslop", { enabled: false, editable: true });
const imageGen = skill("image-gen", { source: "system", path: "/Users/me/.codex/skills/.system/image-gen/SKILL.md", editable: false });
const project = { id: "p1", name: "studio" } as Project;
const version = "a".repeat(64) as FileVersion;
const skillText = "---\nname: research\ndescription: Research a question\n---\n\n# Research\n\nRead the sources first.\n";

function readFile({ skill: path, file }: RpcParams<"skills.readFile">): SkillFileRead {
  if (file === "agents/openai.yaml") return { kind: "missing" };
  if (file === "references/sources.md") return { kind: "text", text: "# Sources\n\nOfficial docs.\n", version, readOnly: null };
  return { kind: "text", text: skillText, version, readOnly: path === imageGen.path ? "Codex owns its built-in skills." : null };
}

type Answers = Partial<{ [M in RpcMethod]: (params: RpcParams<M>) => RpcResults[M] }>;
const defaults: Answers = {
  "projects.list": () => [project],
  "skills.list": ({ agent }) => (agent === "codex" ? [research, deslop, imageGen] : []),
  "skills.files": () => [
    { path: "SKILL.md", kind: "file" },
    { path: "references", kind: "directory" },
    { path: "references/sources.md", kind: "file" },
  ],
  "skills.readFile": readFile,
  "skills.writeFile": () => ({ kind: "saved", version: "b".repeat(64) as FileVersion }),
  "skills.setEnabled": ({ enabled }) => ({ enabled }),
  "skills.setIcon": ({ image }) => ({ icon: image }),
  "skills.remove": () => ({ removed: true }),
};
let answers: Answers = defaults;
const calls: { method: string; params: unknown }[] = [];
const called = (method: RpcMethod) => calls.filter((call) => call.method === method).map((call) => call.params);

beforeEach(() => {
  queryClient.clear();
  answers = { ...defaults };
  vi.spyOn(core, "call").mockImplementation(async <M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResults[M]> => {
    calls.push({ method, params });
    const answer = answers[method] as ((params: RpcParams<M>) => RpcResults[M]) | undefined;
    return answer ? answer(params) : ({} as RpcResults[M]);
  });
});
afterEach(() => {
  cleanup();
  calls.length = 0;
  vi.restoreAllMocks();
});

const mount = () =>
  render(
    <QueryClientProvider client={queryClient}>
      <SkillsSettings active />
    </QueryClientProvider>,
  );
const list = () => screen.getByRole("region", { name: "Skills" });
const ref = (path: string) => ({ agent: "codex", scope: { kind: "project", id: "p1" }, skill: path });

function openMenu(name: string) {
  const trigger = screen.getByRole("button", { name });
  fireEvent.pointerDown(trigger, { pointerType: "mouse", button: 0 });
  fireEvent.click(trigger);
}

it("lists each skill with a switch only where its agent keeps one", async () => {
  mount();
  expect(await within(await screen.findByRole("region", { name: "Skills" })).findByRole("switch", { name: "Use Research" })).toHaveProperty("checked", true);
  expect(within(list()).getByRole("switch", { name: "Use deslop" })).toHaveProperty("checked", false);
  expect(within(list()).getByText("image-gen")).toBeTruthy();
  expect(screen.queryByRole("switch", { name: "Use image-gen" })).toBeNull();
  expect(within(list()).getByText("Yours")).toBeTruthy();
  expect(within(list()).getByText("Built in")).toBeTruthy();
});

it("turns a skill on from its row", async () => {
  mount();
  const toggle = await within(await screen.findByRole("region", { name: "Skills" })).findByRole("switch", { name: "Use deslop" });
  fireEvent.click(toggle);
  await waitFor(() => expect(called("skills.setEnabled")).toEqual([{ ...ref(deslop.path), enabled: true }]));
  expect(within(list()).getByRole("switch", { name: "Use deslop" })).toHaveProperty("checked", true);
});

it("opens the selected skill into its files and shows the one chosen", async () => {
  mount();
  const files = await screen.findByRole("list", { name: "Research files" });
  expect(within(files).getByRole("button", { name: "SKILL.md" }).getAttribute("aria-current")).toBe("true");
  expect(await screen.findByRole("heading", { name: "Research", level: 1 })).toBeTruthy();
  fireEvent.click(within(files).getByRole("button", { name: "references" }));
  fireEvent.click(within(files).getByRole("button", { name: "sources.md" }));
  expect(await screen.findByText("Official docs.")).toBeTruthy();
  expect(called("skills.readFile")).toContainEqual({ ...ref(research.path), file: "references/sources.md" });

  fireEvent.click(within(list()).getByRole("button", { name: /deslop/ }));
  expect(await screen.findByRole("list", { name: "deslop files" })).toBeTruthy();
  expect(called("skills.files")).toContainEqual(ref(deslop.path));
});

it("saves an edit against the version it started from", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Editor" }), { target: { value: `${skillText}More.\n` } });
  expect(screen.getAllByRole("img", { name: "Unsaved changes" })).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(called("skills.writeFile")).toEqual([{ ...ref(research.path), file: "SKILL.md", text: `${skillText}More.\n`, expected: version }]));
  expect(await screen.findByRole("button", { name: "Edit" })).toBeTruthy();
  expect(screen.queryByRole("img", { name: "Unsaved changes" })).toBeNull();
});

it("offers no Edit on a skill the user can't change", async () => {
  mount();
  fireEvent.click(await within(await screen.findByRole("region", { name: "Skills" })).findByRole("button", { name: /image-gen/ }));
  const detail = await screen.findByRole("region", { name: "image-gen" });
  expect(await within(detail).findByText("Read only")).toBeTruthy();
  expect(within(detail).queryByRole("button", { name: "Edit" })).toBeNull();
  expect(within(detail).queryByRole("button", { name: "Image for image-gen" })).toBeNull();
});

it("goes back to the letter from the image menu", async () => {
  mount();
  await screen.findByRole("button", { name: "Image for Research" });
  openMenu("Image for Research");
  fireEvent.click(await screen.findByRole("menuitem", { name: "Use a letter" }));
  await waitFor(() => expect(called("skills.setIcon")).toEqual([{ ...ref(research.path), image: null }]));
});

it("asks before removing a skill", async () => {
  mount();
  await screen.findByRole("button", { name: "More for Research" });
  openMenu("More for Research");
  fireEvent.click(await screen.findByRole("menuitem", { name: "Remove skill" }));
  const dialog = await screen.findByRole("dialog", { name: "Remove Research?" });
  expect(called("skills.remove")).toEqual([]);
  fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
  await waitFor(() => expect(called("skills.remove")).toEqual([ref(research.path)]));
});

it("keeps the typed text when the file changed since the edit began", async () => {
  const current = "---\nname: research\n---\n\nChanged on disk.\n";
  const newer = "c".repeat(64) as FileVersion;
  answers["skills.writeFile"] = ({ expected }) =>
    expected === version ? { kind: "conflict", current: { kind: "text", text: current, version: newer, readOnly: null } } : { kind: "saved", version: "d".repeat(64) as FileVersion };
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Editor" }), { target: { value: "Mine.\n" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByText("SKILL.md changed after you started editing.")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Editor" })).toHaveProperty("value", "Mine.\n");
  fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(called("skills.writeFile").at(-1)).toEqual({ ...ref(research.path), file: "SKILL.md", text: "Mine.\n", expected: newer }));
});

it("shows a new skill in the list even when a search was hiding it", async () => {
  const added = skill("release-notes", { enabled: true, editable: true });
  answers["skills.create"] = () => {
    answers["skills.list"] = ({ agent }) => (agent === "codex" ? [research, deslop, imageGen, added] : []);
    return { skill: added.path };
  };
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Search skills" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search skills" }), { target: { value: "deslop" } });
  openMenu("Add a skill");
  fireEvent.click(await screen.findByRole("menuitem", { name: "Write a skill" }));
  const dialog = await screen.findByRole("dialog", { name: "Write a skill" });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "release-notes" } });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "Description" }), { target: { value: "Write release notes" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add skill" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(await within(list()).findByRole("button", { name: /release-notes/ })).toBeTruthy();
  expect(called("skills.create")).toEqual([{ agent: "codex", scope: { kind: "project", id: "p1" }, place: "user", name: "release-notes", description: "Write release notes", instructions: "" }]);
});
