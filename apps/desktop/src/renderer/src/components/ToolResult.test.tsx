import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { storeToolImages, type AgentEvent } from "@openorc/protocol";
import { core } from "../lib/rpc";
import { applyFrame, getRun, hydrate, resetTranscripts } from "../lib/transcript";
import { ThreadMedia } from "./ThreadImages";
import { TranscriptContents } from "./Transcript";

vi.mock("../lib/rpc", () => ({ core: { call: vi.fn(), onFrame: vi.fn(), onInvalidate: vi.fn(), onReady: vi.fn() } }));
vi.mock("./AgentOrb", () => ({ AgentOrb: () => null }));
vi.mock("./TaskCard", () => ({ TaskCard: () => null }));
vi.mock("./QuestionCard", () => ({ QuestionCard: () => null }));

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const image = { type: "image", mimeType: "image/png", data: png };
const text = { type: "text", text: '{"screens":[{"app_name":"Example","image_url":"https://example.com/screen"}]}' };
const base = { runId: "rich-result", ts: 1000 };
const start: AgentEvent = { ...base, type: "tool.started", toolCallId: "search", name: "mobbin.search_screens", input: { query: "appearance" }, parentToolCallId: null };
const completed = (output: unknown): AgentEvent => ({ ...base, type: "tool.completed", toolCallId: "search", name: "mobbin.search_screens", output, isError: false });
function view() {
  return (
    <ThreadMedia scopeKey={base.runId}>
      <TranscriptContents runId={base.runId} blocks={[...(getRun(base.runId)?.blocks ?? [])]} groupTools={false} />
    </ThreadMedia>
  );
}
function show(output: unknown) {
  applyFrame({ runId: base.runId, seq: 1, events: [start, completed(output)] });
  const result = render(view());
  fireEvent.click(screen.getByRole("button", { name: /Mobbin: search screens/ }));
  return result;
}
beforeEach(() => {
  resetTranscripts();
  vi.clearAllMocks();
});
afterEach(cleanup);

it.each([["Codex MCP", { content: [text, image], structuredContent: { screens: [{ app_name: "Example" }] } }]])(
  "renders %s images through the transcript, with an accessible viewer and retained text",
  async (_provider, output) => {
    const { container } = show(output);
    const thumbnail = screen.getByRole("img", { name: "Tool image 1" });
    expect(thumbnail.getAttribute("src")).toBe(`data:image/png;base64,${png}`);
    expect(container.textContent).not.toContain(png);
    fireEvent.click(screen.getByText("Result text"));
    expect(screen.getByText(text.text)).toBeTruthy();
    const opener = screen.getByRole("button", { name: "View image: Tool image 1" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Tool image 1" });
    expect(within(dialog).getByRole("img").getAttribute("src")).toBe(thumbnail.getAttribute("src"));
    expect(within(dialog).getByRole("button", { name: "Zoom in" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close image viewer" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  },
);

it.each([
  ["Codex MCP", { content: [text, image] }],
  ["Claude", [text, { type: "image", source: { type: "base64", media_type: "image/png", data: png } }]],
])("renders %s images the ledger stored as files from their asset URL", (_provider, output) => {
  const url = "openorc-asset://tool-images/rich-result/0a1b-2c.png";
  const stored = storeToolImages(output, () => url);
  expect(JSON.stringify(stored)).not.toContain(png);
  show(stored);
  expect(screen.getAllByRole("img")[0]!.getAttribute("src")).toBe(url);
});

it("restores image-only results from the ledger without requiring a live provider", async () => {
  vi.mocked(core.call).mockResolvedValue({ events: JSON.parse(JSON.stringify([start, completed({ content: [image] })])), fromTurn: 0, live: false });
  await hydrate(base.runId);
  render(view());
  fireEvent.click(screen.getByRole("button", { name: /Mobbin: search screens/ }));
  expect(screen.getAllByRole("img")).toHaveLength(1);
  expect(screen.queryByText("Result text")).toBeNull();
});

it("keeps plain output verbatim and replaces it with media on completion", () => {
  const { rerender } = show("first line\n<script>not markup</script>");
  expect(screen.getByText(/first line/).textContent).toBe("first line\n<script>not markup</script>");
  applyFrame({ runId: base.runId, seq: 2, events: [completed({ content: [image] })] });
  rerender(view());
  expect(screen.queryByText(/first line/)).toBeNull();
  expect(screen.getByRole("img")).toBeTruthy();
});

it("renders embedded resource images and text, and safe resource links", () => {
  const { container } = show({
    content: [
      { type: "resource", resource: { uri: "resource://screen", mimeType: "image/png", blob: png } },
      { type: "resource", resource: { uri: "resource://readme", mimeType: "text/plain", text: "Reference notes" } },
      { type: "resource_link", uri: "https://example.com/reference", name: "Reference screen", mimeType: "image/png" },
      { type: "resource_link", uri: "javascript:alert(1)", name: "Untrusted link" },
    ],
  });
  expect(screen.getByRole("img")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Reference screen" }).getAttribute("href")).toBe("https://example.com/reference");
  expect(screen.queryByRole("link", { name: "Untrusted link" })).toBeNull();
  expect(container.textContent).toContain("Reference notes");
  expect(container.textContent).not.toContain(png);
});

it("keeps unknown and malformed blocks inspectable without crashing or dumping binary data", async () => {
  const { container } = show({
    content: [null, { type: "future", value: 42 }, { type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" }, { type: "audio", data: "QUJDRA==", mimeType: "audio/wav" }],
    structuredContent: { count: 4 },
  });
  expect(screen.queryByRole("img")).toBeNull();
  expect(container.textContent).toContain("Image preview unavailable");
  expect(container.textContent).toContain("42");
  expect(container.textContent).not.toContain("PHN2Zz4=");
  expect(container.textContent).not.toContain("QUJDRA==");
  fireEvent.click(screen.getByText("Result data"));
  await waitFor(() => expect(container.textContent).toContain('"count": 4'));
  expect(container.textContent).not.toContain("PHN2Zz4=");
  expect(container.textContent).not.toContain("QUJDRA==");
});

it("shows broken-image feedback and recovers when a new image replaces it", () => {
  const { rerender } = show({ content: [image] });
  fireEvent.error(screen.getByRole("img"));
  expect(screen.getByText(/Image unavailable/)).toBeTruthy();
  const next = { ...image, data: png + "\n" };
  applyFrame({ runId: base.runId, seq: 2, events: [completed({ content: [next] })] });
  rerender(view());
  expect(screen.getByRole("img").getAttribute("src")).toBe(`data:image/png;base64,${next.data}`);
});
