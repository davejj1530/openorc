import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { HostedFileScope, ThreadSummary } from "@openorc/protocol";

const scope: HostedFileScope = { accountId: "ada", apiOrigin: "https://api.example.com", spaceId: "personal", destination: { kind: "hosted", projectId: "server-project", threadId: "cloud" } };
const { call } = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("../lib/rpc", () => ({ core: { call, onPush: () => () => {} } }));
vi.mock("../lib/hosted-file-scope", () => ({ useHostedFileScope: () => scope }));
vi.mock("../lib/organization-content-gate", () => {
  const snapshot = { generation: 1 };
  return {
    organizationContentGate: { subscribe: () => () => {}, getSnapshot: () => snapshot, capture: () => ({ current: () => true }) },
    startOrganizationContentGate: () => () => {},
  };
});

import { HostedMessageAttachments } from "./HostedMessageAttachments";
import { ThreadMedia } from "./ThreadImages";

const thread = { id: "cloud", projectId: "project" } as ThreadSummary;
const PNG = "iVBORw0KGgo=";

beforeEach(() => {
  call.mockReset();
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:thumbnail", revokeObjectURL: () => undefined }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("shows a sent image by its authorized thumbnail and a document by name, and downloads each original through core", async () => {
  call.mockImplementation(async (method: string) => (method === "hostedFiles.thumbnail" ? { contentType: "image/webp", data: PNG } : { saved: true }));
  render(<HostedMessageAttachments thread={thread} paths={["/hosted/files/f1/sidebar.png", "/hosted/files/f2/release-notes.pdf"]} />);
  const image = await screen.findByRole("button", { name: "View image: sidebar.png" });
  expect(image.querySelector("img")!.getAttribute("src")).toBe("blob:thumbnail");
  expect(call).toHaveBeenCalledWith("hostedFiles.thumbnail", { scope, file: { id: "f1", name: "sidebar.png" } });
  const document = screen.getByRole("button", { name: "release-notes.pdf" });
  expect(document.getAttribute("data-tip")).toBe("Download release-notes.pdf");
  fireEvent.click(document);
  await waitFor(() => expect(call).toHaveBeenCalledWith("hostedFiles.download", { scope, file: { id: "f2", name: "release-notes.pdf" } }));
  expect(call.mock.calls.map(([method]) => method)).not.toContain("hostedFiles.read");
});

it("turns a refused thumbnail into the file's name with the read's own words once, and tries it again on request", async () => {
  let refused = true;
  call.mockImplementation(async (method: string) => {
    if (method !== "hostedFiles.thumbnail") return { saved: true };
    if (refused) throw new Error("OpenOrc Cloud can't be reached.");
    return { contentType: "image/webp", data: PNG };
  });
  render(<HostedMessageAttachments thread={thread} paths={["/hosted/files/f1/sidebar.png"]} />);
  expect(await screen.findByRole("button", { name: "sidebar.png" })).toBeTruthy();
  expect(screen.getAllByText("OpenOrc Cloud can't be reached.")).toHaveLength(1);
  refused = false;
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Try again" })));
  expect(await screen.findByRole("button", { name: "View image: sidebar.png" })).toBeTruthy();
  expect(screen.queryByText("OpenOrc Cloud can't be reached.")).toBeNull();
});

it("shows an image the server made no thumbnail for as a plain file, with no failure", async () => {
  call.mockImplementation(async (method: string) => {
    if (method === "hostedFiles.thumbnail") throw new Error("That file has no thumbnail.");
    return { saved: true };
  });
  render(<HostedMessageAttachments thread={thread} paths={["/hosted/files/f1/huge.png"]} />);
  expect(await screen.findByRole("button", { name: "huge.png" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});

it("says a failed download beside its file", async () => {
  call.mockImplementation(async (method: string) => {
    if (method === "hostedFiles.download") throw new Error("You're not in this organization.");
    return undefined;
  });
  render(<HostedMessageAttachments thread={thread} paths={["/hosted/files/f2/release-notes.pdf"]} />);
  fireEvent.click(screen.getByRole("button", { name: "release-notes.pdf" }));
  expect((await screen.findByRole("alert")).textContent).toBe("You're not in this organization.");
});

it("opens a sent picture's preview with Download, never claiming the preview's size is the original's", async () => {
  call.mockImplementation(async (method: string) => (method === "hostedFiles.thumbnail" ? { contentType: "image/webp", data: PNG } : { saved: true }));
  render(
    <ThreadMedia scopeKey="cloud">
      <HostedMessageAttachments thread={thread} paths={["/hosted/files/f1/sidebar.png"]} />
    </ThreadMedia>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "View image: sidebar.png" }));
  const viewer = await screen.findByRole("dialog");
  fireEvent.load(viewer.querySelector("img")!);
  expect(viewer.textContent).toContain("Image preview");
  expect(viewer.textContent).not.toMatch(/\d+ × \d+/);
  expect(screen.queryByRole("button", { name: "Show image in folder" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Download sidebar.png" }));
  await waitFor(() => expect(call).toHaveBeenCalledWith("hostedFiles.download", { scope, file: { id: "f1", name: "sidebar.png" } }));
});
