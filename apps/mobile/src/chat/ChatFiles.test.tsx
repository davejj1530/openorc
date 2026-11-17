// @vitest-environment jsdom
import type { HostedFileScope, TeamChatFile } from "@openorc/protocol";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Share } from "react-native";
import { afterEach, expect, it, vi } from "vitest";
import { ChatFiles, ChatFileScopeContext } from "./ChatFiles";

const files = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../client", () => ({ cloud: { hosted: {} }, chatFileUri: files.read }));
vi.mock("../thread/images", () => ({ ChatImageTile: ({ file }: { file: TeamChatFile }) => <span>{`image ${file.name}`}</span> }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  files.read.mockReset();
});

const scope: HostedFileScope = { accountId: "u-riley", apiOrigin: "https://cloud.example", spaceId: "org-birch", destination: { kind: "chat", conversationId: "c-launch" } };
const file = (id: string, name: string, kind: TeamChatFile["kind"], bytes = 2048): TeamChatFile => ({ id, name, kind, bytes, contentType: "application/octet-stream" });

it("shows images as tiles and other files by name and size, and offers a file read once through the phone's session", async () => {
  const share = vi.spyOn(Share, "share");
  files.read.mockResolvedValue("file:///cache/plans.pdf");
  render(
    <ChatFileScopeContext.Provider value={scope}>
      <ChatFiles files={[file("f1", "board.png", "image"), file("f2", "plans.pdf", "file")]} mine={false} />
    </ChatFileScopeContext.Provider>,
  );
  expect(screen.getByText("image board.png")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "plans.pdf, 2 KB" }));
  await waitFor(() => expect(share).toHaveBeenCalledWith({ url: "file:///cache/plans.pdf" }));
  expect(files.read).toHaveBeenCalledWith({}, scope, expect.objectContaining({ id: "f2" }));
});

it("says why a file could not be read, under it", async () => {
  files.read.mockRejectedValue(new Error("You're not in this organization."));
  render(
    <ChatFileScopeContext.Provider value={scope}>
      <ChatFiles files={[file("f2", "plans.pdf", "file")]} mine />
    </ChatFileScopeContext.Provider>,
  );
  fireEvent.click(screen.getByRole("button"));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "You're not in this organization.");
});
