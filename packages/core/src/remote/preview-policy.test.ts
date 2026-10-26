import { describe, expect, it } from "vitest";
import { isRemoteMethod, REMOTE_METHODS, rpcParams, sessionRpcParams, type PreviewState } from "@openorc/protocol";
import { phoneAddress as shapeAddress, previewReply, remoteError, type MacRoots } from "./phone-words.js";
import { admitRemoteRequest, remoteReply, type GuardContext } from "./policy.js";

const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const roots: MacRoots = { home: "/Users/me", dataDir: "/Users/me/Library/Application Support/OpenOrc", projects: ["/Users/me/dev/site"] };
const words = (message: string) => `shaped: ${message}`;
const macWords = (message: string) => remoteError(message, roots);
const phoneAddress = (url: string) => shapeAddress(url, roots);
const shaping = (fake = words) => ({ words: fake, roots: () => roots });
const context: GuardContext = { attachmentsDir: "/data/attachments", thread: (id) => (id === "gone" ? null : { team: false }) };
const page = (overrides: Partial<Extract<PreviewState, { open: true }>> = {}): PreviewState => ({
  open: true,
  pane: "0123456789ab",
  address: "http://127.0.0.1:47831/",
  title: "QA Page",
  phase: "live",
  error: null,
  frame: null,
  ...overrides,
});

describe("a Preview address as a phone hears it", () => {
  it("loses its fragment, where implicit OAuth puts tokens", () => {
    expect(phoneAddress("https://app.example.com/callback#access_token=abc&expires_in=3600")).toBe("https://app.example.com/callback");
    expect(phoneAddress("http://127.0.0.1:47831/secret?code=abc&state=xyz#access_token=zzz")).toBe("http://127.0.0.1:47831/secret?code=[redacted:query]&state=[redacted:query]");
  });

  it("loses the values of secret-named query keys and keeps the rest as written", () => {
    expect(phoneAddress("https://example.com/a?page=2&id_token=x&api_key=k&KEY=1&sig=s&signature=t&session=u&sid=v&password=p&secret=q&otp=1&ticket=t&nonce=n&token=w&q=hello%20world")).toBe(
      "https://example.com/a?page=2&id_token=[redacted:query]&api_key=[redacted:query]&KEY=[redacted:query]&sig=[redacted:query]&signature=[redacted:query]&session=[redacted:query]&sid=[redacted:query]&password=[redacted:query]&secret=[redacted:query]&otp=[redacted:query]&ticket=[redacted:query]&nonce=[redacted:query]&token=[redacted:query]&q=hello%20world",
    );
    expect(phoneAddress("https://example.com/search?q=state+of+the+art&keyword=a")).toBe("https://example.com/search?q=state+of+the+art&keyword=a");
  });

  it("then passes redaction, and leaves an ordinary address as it is", () => {
    expect(phoneAddress(`https://example.com/${TOKEN}/view`)).toBe("https://example.com/[redacted:github-token]/view");
    expect(phoneAddress("http://localhost:5173/app?tab=1")).toBe("http://localhost:5173/app?tab=1");
    expect(phoneAddress("about:blank")).toBe("about:blank");
  });

  it("names the Mac's own folders in a web address, as a file path typed into the address field loads as one", () => {
    // The field turns file:///Users/me/... into http://file:///Users/me/..., which loads as http://file///Users/me/...
    expect(phoneAddress("http://file///Users/me/dev/site/secret.html")).toBe("http://file///site/secret.html");
    expect(phoneAddress("http://file///Users/me/notes/plan.html")).toBe("http://file///~/notes/plan.html");
    expect(phoneAddress("http://localhost:5173/@fs/Users/me/dev/site/src/main.ts?t=1")).toBe("http://localhost:5173/@fs/site/src/main.ts?t=1");
    expect(phoneAddress("http://localhost:5173/x?file=%2FUsers%2Fme")).toBe("http://localhost:5173/x?file=%2FUsers%2Fme");
    expect(phoneAddress("https://example.com/Users/meg/profile?next=/home")).toBe("https://example.com/Users/meg/profile?next=/home");
  });

  it("reads like the Mac's other words when it is text the pane refused, not a web address", () => {
    expect(phoneAddress("file:///Users/me/dev/site/secret.html")).toBe("secret.html");
    expect(phoneAddress("/Users/me/notes/plan.txt")).toBe("notes/plan.txt");
    expect(phoneAddress(`file:///opt/share/page.html?t=${TOKEN}`)).toBe("page.html?t=[redacted:github-token]");
    const refused = page({ address: "file:///Users/me/dev/site/secret.html", phase: "failed", error: "Use an HTTP or HTTPS website URL without embedded credentials." });
    expect(previewReply(refused, shaping(macWords))).toMatchObject({ address: "secret.html" });
  });
});

describe("a Preview state as a phone hears it", () => {
  it("shapes the address, and passes the title and the error through the phone's words", () => {
    const state = page({ address: "http://127.0.0.1:47831/secret?code=abc#t=1", title: `QA Secret ${TOKEN}`, phase: "failed", error: "Nothing is listening on 127.0.0.1:47831 yet." });
    expect(previewReply(state, shaping())).toEqual({
      ...state,
      address: "http://127.0.0.1:47831/secret?code=[redacted:query]",
      title: `shaped: QA Secret ${TOKEN}`,
      error: "shaped: Nothing is listening on 127.0.0.1:47831 yet.",
    });
    expect(previewReply({ open: false }, shaping())).toEqual({ open: false });
  });

  it("is what preview.state answers a phone, its title free of tokens and the Mac's folders", () => {
    const phoneWords = (message: string) => message.replace(TOKEN, "[redacted:github-token]").replace(roots.home, "~");
    expect(remoteReply("preview.state", page({ title: `QA Secret ${TOKEN} in /Users/me` }), shaping(phoneWords))).toMatchObject({ title: "QA Secret [redacted:github-token] in ~" });
  });
});

describe("what a phone may ask of the Preview", () => {
  it("reads a thread's Preview state", () => {
    expect(isRemoteMethod("preview.state")).toBe(true);
    expect(admitRemoteRequest("preview.state", { threadId: "t1" }, context)).toEqual({ ok: true });
  });

  it("watches only through its own session: the session methods are no core method and no phone RPC", () => {
    for (const method of Object.keys(sessionRpcParams)) {
      expect(Object.hasOwn(rpcParams, method), method).toBe(false);
      expect(isRemoteMethod(method), method).toBe(false);
    }
    expect(sessionRpcParams["preview.watch"].safeParse({ threadId: "t1", width: 786, pace: "lan" }).success).toBe(true);
    for (const params of [
      { threadId: "t1", width: 786, pace: "lan", command: { action: "click", ref: "e1" } },
      { threadId: "t1", width: 4000, pace: "lan" },
      { threadId: "t1", width: 786, pace: "cellular" },
    ])
      expect(sessionRpcParams["preview.watch"].safeParse(params).success, JSON.stringify(params)).toBe(false);
    expect(sessionRpcParams["preview.unwatch"].safeParse({ threadId: "t1" }).success).toBe(false);
  });

  it("still cannot act on a page, nor see a task's or a project's preview", () => {
    expect(REMOTE_METHODS.filter((method) => method.startsWith("browser"))).toEqual([]);
    expect(Object.keys(rpcParams).filter((method) => method.startsWith("browser"))).toEqual([]);
    for (const method of ["browser.command", "browser:navigate", "browser:reload", "browser:show", "browser:close", "browser:capture"])
      expect(admitRemoteRequest(method, { surface: "thread:t1", command: { action: "open", url: "https://example.com" } }, context)).toEqual({
        ok: false,
        message: "This is not available from a phone.",
      });
    for (const threadId of ["task:t1", "thread:t1", "project:p1", "../t1"]) {
      expect(rpcParams["preview.state"].safeParse({ threadId }).success, threadId).toBe(false);
      expect(sessionRpcParams["preview.watch"].safeParse({ threadId, width: 786, pace: "lan" }).success, threadId).toBe(false);
    }
  });
});
