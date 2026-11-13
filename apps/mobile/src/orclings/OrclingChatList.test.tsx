// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import type { Block } from "@openorc/client";
import { defaultOrclingLook, type OrclingChatSummary } from "@openorc/protocol";
import { Fragment, type ReactElement } from "react";
import { afterEach, expect, it, vi } from "vitest";

const seen = vi.hoisted(() => ({ tiles: [] as { asset: unknown; label: string }[], words: [] as string[] }));
vi.mock("@legendapp/list/keyboard", () => ({
  KeyboardAwareLegendList: ({ data, renderItem }: { data: { key: string }[]; renderItem: (info: { item: unknown; index: number }) => ReactElement }) => (
    <>
      {data.map((item, index) => (
        <Fragment key={item.key}>{renderItem({ item, index })}</Fragment>
      ))}
    </>
  ),
}));
vi.mock("react-native-keyboard-controller", () => ({ useReanimatedKeyboardAnimation: () => ({ height: { value: 0 } }) }));
vi.mock("expo-router", () => ({ router: { push: () => undefined } }));
vi.mock("../client", () => ({ useHostClient: () => null, hostClient: () => null, useRpc: () => ({ data: undefined }), useRpcMutation: () => ({ mutate: () => undefined }) }));
vi.mock("./use-reactions", () => ({
  reactionKey: (runId: string | undefined, messageId: string, part: number) => `${runId ?? ""}|${messageId}|${part}`,
  useReactions: () => ({ person: () => null, orcling: () => null, choose: () => undefined }),
}));
vi.mock("./OrclingFace", () => ({ OrclingFace: () => null }));
vi.mock("../thread/Markdown", () => ({ Markdown: ({ text }: { text: string }) => void seen.words.push(text) }));
vi.mock("../thread/images", () => ({ ImageTile: ({ asset, label }: { asset: unknown; label: string }) => void seen.tiles.push({ asset, label }) }));

const { OrclingChatList } = await import("./OrclingChatList");

afterEach(cleanup);

const autumn: OrclingChatSummary = { id: "autumn", name: "Autumn", look: defaultOrclingLook, threadId: "home", thread: null, last: null };

it("shows a picture of a file on the Mac as the picture, asked of the Mac by its message, with the words around it as bubbles", () => {
  const reply: Block = {
    id: "a1",
    kind: "message",
    role: "assistant",
    text: "Here it is as an image instead:\n\n![Sign-in flow](/Users/me/flow.png)\n\nRead each section from top to bottom.",
    streaming: false,
    at: 1,
    runId: "run",
  };
  render(
    <OrclingChatList
      chat={autumn}
      blocks={[reply]}
      typing={false}
      runId="run"
      hasOlder={false}
      loadOlder={() => undefined}
      composerInset={{ value: 0 } as never}
      listRef={{ current: null }}
      followKey={0}
    />,
  );
  expect(seen.tiles).toEqual([{ asset: { kind: "reply-image", runId: "run", messageId: "a1", path: "/Users/me/flow.png" }, label: "Sign-in flow" }]);
  expect(seen.words).toEqual(["Here it is as an image instead:", "Read each section from top to bottom."]);
});
