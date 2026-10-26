// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PreviewInput, PreviewInputRequest } from "@openorc/protocol";
import { applyInput, type PaneLink } from "./preview-input";

/**
 * A pane as its debugger and isolated world see it: CDP commands are recorded, and page code runs against this test's
 * own document, so the hit test and the focus reader meet real elements. Layout is the only stand-in: jsdom has none,
 * so `hit` says what lies under a point.
 */
class FakePane implements PaneLink {
  readonly sent: { method: string; params: Record<string, unknown> }[] = [];
  viewport = { clientWidth: 1000, clientHeight: 720, offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, scale: 1 };
  hit: Element | null = null;
  constructor() {
    document.elementFromPoint = (x: number, y: number) => {
      this.points.push({ x, y });
      return this.hit;
    };
  }
  readonly points: { x: number; y: number }[] = [];
  /** Page.addScriptToEvaluateOnNewDocument's scripts by identifier, as each new document runs them. */
  readonly scripts = new Map<string, string>();
  private nextScript = 0;
  /** What a click does on the page, as Chromium would deliver it. */
  onClick: () => void = () => undefined;
  /** A page that does not answer this method until the test lets it, as one whose script spins. */
  stuck: { method: string; type?: string; answer: () => void } | null = null;
  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.sent.push({ method, params });
    const stuck = this.stuck;
    if (stuck && stuck.method === method && (stuck.type === undefined || stuck.type === params["type"])) await new Promise<void>((resolve) => (stuck.answer = resolve));
    return this.answer(method, params);
  }
  private answer(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "Input.dispatchMouseEvent" && params["type"] === "mouseReleased") this.onClick();
    if (method === "Page.getLayoutMetrics") return Promise.resolve({ cssVisualViewport: this.viewport });
    if (method === "Page.addScriptToEvaluateOnNewDocument") {
      const identifier = String(++this.nextScript);
      this.scripts.set(identifier, String(params["source"]));
      // runImmediately: the documents the pane has run it too.
      if (params["runImmediately"]) for (const page of this.documents) page.eval(String(params["source"]));
      return Promise.resolve({ identifier });
    }
    if (method === "Page.removeScriptToEvaluateOnNewDocument") this.scripts.delete(String(params["identifier"]));
    return Promise.resolve({});
  }
  /** Sends of `method` (of `type`, for input events) wait until the returned function is called. */
  stick(method: string, type?: string): () => void {
    const stuck = { method, type, answer: () => undefined };
    this.stuck = stuck;
    return () => {
      this.stuck = null;
      stuck.answer();
    };
  }
  /**
   * A document the pane loads next, as after a link: a window of its own, starting with none of the last one's state,
   * whose dialogs record that they showed. Scripts see it as their `window` and `document`.
   */
  load(visibility: "visible" | "hidden" = "visible") {
    const shown: string[] = [];
    const page: Record<string, unknown> = {
      alert: () => void shown.push("alert"),
      confirm: () => (shown.push("confirm"), true),
      prompt: () => (shown.push("prompt"), "typed"),
      print: () => void shown.push("print"),
    };
    page["top"] = page;
    const run = (source: string) => new Function("window", "document", source)(page, { visibilityState: visibility });
    for (const source of this.scripts.values()) run(source);
    this.documents.push({ eval: run });
    const dialogs = page as unknown as Window;
    return { shown, dialogs: () => [dialogs.alert("Hi"), dialogs.confirm("Delete it?"), dialogs.prompt("Name?"), dialogs.print()] };
  }
  /** The documents loaded so far, which a script run immediately reaches. */
  private readonly documents: { eval(code: string): unknown }[] = [];
  run(code: string): Promise<unknown> {
    return Promise.resolve((0, eval)(code));
  }
  input() {
    return this.sent.filter(({ method }) => method.startsWith("Input."));
  }
}

let pane: FakePane;
const request = (input: PreviewInput, frame = { width: 786, height: 566 }): PreviewInputRequest => ({ pane: "0123456789ab", frame, input });
const tap = (x: number, y: number, count = 1) => request({ kind: "tap", x, y, count });

/**
 * A same-origin frame at (100, 50) on the page, 10 px of border and padding inside its box, holding `html`. `hit` says
 * what lies under a point of the frame's own document, which records the points it was asked.
 */
function framed(html: string) {
  document.body.innerHTML = `<iframe id="frame"></iframe>`;
  const frame = document.getElementById("frame") as HTMLIFrameElement;
  frame.getBoundingClientRect = () => ({ left: 100, top: 50, right: 500, bottom: 350, width: 400, height: 300, x: 100, y: 50, toJSON: () => ({}) });
  Object.defineProperties(frame, { clientLeft: { value: 4 }, clientTop: { value: 4 } });
  frame.style.padding = "6px";
  const inner = frame.contentDocument!;
  inner.body.innerHTML = html;
  const points: { x: number; y: number }[] = [];
  const view = { hit: null as Element | null, points, inner, frame };
  inner.elementFromPoint = (x: number, y: number) => (points.push({ x, y }), view.hit);
  pane.hit = frame;
  return view;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = "";
  pane = new FakePane();
});
afterEach(() => vi.useRealTimers());

describe("a phone's tap", () => {
  it("clicks the CSS pixel the phone aimed at, mapped from the frame onto the pane's viewport", async () => {
    pane.hit = document.body;
    expect(await applyInput(pane, tap(393, 283))).toEqual({ kind: "applied", focus: null });
    // No mouse move first: a pane off screen takes a move only with its next frame, about once a second.
    expect(pane.input()).toEqual([
      { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 500, y: 360, button: "left", buttons: 1, clickCount: 1 } },
      { method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: 500, y: 360, button: "left", buttons: 0, clickCount: 1 } },
    ]);
  });

  it("lands on the same pixel from a frame of any width, and a second tap of a double tap is a double click", async () => {
    pane.hit = document.body;
    await applyInput(pane, request({ kind: "tap", x: 800, y: 576, count: 2 }, { width: 1600, height: 1152 }));
    const pressed = pane.input().find(({ params }) => params["type"] === "mousePressed")!;
    expect(pressed.params).toMatchObject({ x: 500, y: 360, clickCount: 2 });
  });

  it("is dropped when the frame's shape no longer matches the viewport, as after a resize or another tab", async () => {
    expect(await applyInput(pane, request({ kind: "tap", x: 10, y: 10, count: 1 }, { width: 786, height: 786 }))).toEqual({ kind: "refused", reason: "pane" });
    expect(pane.input()).toEqual([]);
  });

  it("focuses a select without clicking it, so no native menu opens, and answers its options", async () => {
    document.body.innerHTML = `<select id="plan"><option>Free</option><option disabled>Team</option><option selected>Pro ghp_x</option></select>`;
    const select = document.getElementById("plan")!;
    pane.hit = select;
    expect(await applyInput(pane, tap(100, 100))).toEqual({
      kind: "applied",
      focus: {
        kind: "choice",
        options: [
          { label: "Free", disabled: false },
          { label: "Team", disabled: true },
          { label: "Pro ghp_x", disabled: false },
        ],
        selected: 2,
      },
    });
    expect(document.activeElement).toBe(select);
    expect(pane.input()).toEqual([]);
  });

  it("focuses color and date inputs without a click, so no picker opens; a date takes typed digits", async () => {
    document.body.innerHTML = `<input id="color" type="color"><input id="when" type="date">`;
    pane.hit = document.getElementById("color");
    expect(await applyInput(pane, tap(10, 10))).toEqual({ kind: "applied", focus: null });
    expect(document.activeElement?.id).toBe("color");
    pane.hit = document.getElementById("when");
    expect(await applyInput(pane, tap(10, 10))).toEqual({ kind: "applied", focus: { kind: "text", keyboard: "numeric", enter: "default", secure: false, multiline: false } });
    expect(pane.input()).toEqual([]);
  });

  it("reaches into a same-origin frame: a select there is focused, not clicked, so no native menu opens, and answers its options", async () => {
    const view = framed(`<select id="size"><option>S</option><option selected>M</option></select>`);
    view.hit = view.inner.getElementById("size");
    // (393, 283) in the frame is (500, 360) on the viewport: (390, 300) in the frame's document.
    expect(await applyInput(pane, tap(393, 283))).toEqual({
      kind: "applied",
      focus: {
        kind: "choice",
        options: [
          { label: "S", disabled: false },
          { label: "M", disabled: false },
        ],
        selected: 1,
      },
    });
    expect(view.points).toEqual([{ x: 390, y: 300 }]);
    expect(view.inner.activeElement?.id).toBe("size");
    expect(pane.input()).toEqual([]);
  });

  it("clicks a field inside a same-origin frame and answers its keyboard, so the phone can type there", async () => {
    const view = framed(`<input id="email" type="email">`);
    const field = view.inner.getElementById("email") as HTMLInputElement;
    view.hit = field;
    // The click itself is Chromium's to route into the frame; this stands in for the focus it gives.
    pane.onClick = () => field.focus();
    expect(await applyInput(pane, tap(393, 283))).toEqual({ kind: "applied", focus: { kind: "text", keyboard: "email", enter: "default", secure: false, multiline: false } });
    expect(pane.input().map(({ params }) => params["type"])).toEqual(["mousePressed", "mouseReleased"]);
  });
});

describe("a phone's scroll, text and keys", () => {
  it("scrolls the page by the finger's travel in CSS pixels at once, not with a wheel a pane off screen takes a second later", async () => {
    const page = vi.fn();
    Object.defineProperty(document, "scrollingElement", { configurable: true, value: { scrollBy: page } });
    pane.hit = document.body;
    await applyInput(pane, request({ kind: "scroll", x: 393, y: 283, dx: -39.3, dy: 283 }));
    expect(pane.points).toEqual([{ x: 500, y: 360 }]);
    expect(page).toHaveBeenCalledExactlyOnceWith({ left: -50, top: 360, behavior: "instant" });
    expect(pane.input()).toEqual([]);
  });

  it("scrolls the scroller under the finger when it can go that way, else the page", async () => {
    const page = vi.fn();
    Object.defineProperty(document, "scrollingElement", { configurable: true, value: { scrollBy: page } });
    document.body.innerHTML = `<div id="list" style="overflow-y: auto"><p id="row">Row</p></div>`;
    const list = document.getElementById("list")!;
    const inner = vi.fn();
    Object.assign(list, { scrollBy: inner });
    Object.defineProperties(list, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 }, scrollTop: { value: 0, writable: true } });
    pane.hit = document.getElementById("row");
    await applyInput(pane, request({ kind: "scroll", x: 10, y: 10, dx: 0, dy: 100 }));
    expect(inner).toHaveBeenCalledExactlyOnceWith({ left: 0, top: 127.21, behavior: "instant" });
    // At its top already, a scroll up is the page's.
    await applyInput(pane, request({ kind: "scroll", x: 10, y: 10, dx: 0, dy: -100 }));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(page).toHaveBeenCalledExactlyOnceWith({ left: 0, top: -127.21, behavior: "instant" });
  });

  it("scrolls inside a same-origin frame under the finger: its scroller, then its own page, and the outer page only once neither can go", async () => {
    const page = vi.fn();
    Object.defineProperty(document, "scrollingElement", { configurable: true, value: { scrollBy: page } });
    const view = framed(`<div id="list" style="overflow-y: auto"><p id="row">Row</p></div>`);
    const list = view.inner.getElementById("list")!;
    const inner = vi.fn();
    Object.assign(list, { scrollBy: inner });
    Object.defineProperties(list, { scrollHeight: { value: 1000 }, clientHeight: { value: 200 }, scrollTop: { value: 0 } });
    const framePage = view.inner.documentElement;
    const own = vi.fn();
    Object.assign(framePage, { scrollBy: own });
    Object.defineProperty(view.inner, "scrollingElement", { configurable: true, value: framePage });
    Object.defineProperties(framePage, { scrollHeight: { value: 3000 }, clientHeight: { value: 300 }, scrollTop: { value: 0, writable: true } });
    view.hit = view.inner.getElementById("row");
    await applyInput(pane, request({ kind: "scroll", x: 393, y: 283, dx: 0, dy: 100 }));
    expect(view.points).toEqual([{ x: 390, y: 300 }]);
    expect(inner).toHaveBeenCalledExactlyOnceWith({ left: 0, top: 127.21, behavior: "instant" });
    // The list is at its top: a scroll up is the frame's page's, at its top too: the outer page's.
    framePage.scrollTop = 500;
    await applyInput(pane, request({ kind: "scroll", x: 393, y: 283, dx: 0, dy: -100 }));
    expect(own).toHaveBeenCalledExactlyOnceWith({ left: 0, top: -127.21, behavior: "instant" });
    framePage.scrollTop = 0;
    await applyInput(pane, request({ kind: "scroll", x: 393, y: 283, dx: 0, dy: -100 }));
    expect(page).toHaveBeenCalledExactlyOnceWith({ left: 0, top: -127.21, behavior: "instant" });
    expect(inner).toHaveBeenCalledTimes(1);
    expect(own).toHaveBeenCalledTimes(1);
  });

  it("types text as the keyboard committed it, and presses Backspace, Enter and Tab as keys", async () => {
    await applyInput(pane, request({ kind: "text", text: "Hello, wörld" }));
    await applyInput(pane, request({ kind: "key", key: "Backspace", count: 2 }));
    await applyInput(pane, request({ kind: "key", key: "Enter", count: 1 }));
    await applyInput(pane, request({ kind: "key", key: "Tab", count: 1 }));
    const keys = pane
      .input()
      .map(({ method, params }) => (method === "Input.insertText" ? `text ${String(params["text"])}` : `${String(params["type"])} ${String(params["key"])}${params["text"] ? " with text" : ""}`));
    expect(keys).toEqual([
      "text Hello, wörld",
      "rawKeyDown Backspace",
      "keyUp Backspace",
      "rawKeyDown Backspace",
      "keyUp Backspace",
      "keyDown Enter with text",
      "keyUp Enter",
      "rawKeyDown Tab",
      "keyUp Tab",
    ]);
    const backspace = pane.input().find(({ params }) => params["key"] === "Backspace")!.params;
    expect(backspace).toMatchObject({ code: "Backspace", windowsVirtualKeyCode: 8 });
  });

  it("chooses an option of the focused select, as a person would, with input and change events", async () => {
    document.body.innerHTML = `<select id="plan"><option>Free</option><option disabled>Team</option><option>Pro</option></select>`;
    const select = document.getElementById("plan") as HTMLSelectElement;
    const heard: string[] = [];
    select.addEventListener("input", () => heard.push(`input ${select.value}`));
    select.addEventListener("change", () => heard.push(`change ${select.value}`));
    select.focus();
    expect(await applyInput(pane, request({ kind: "choose", index: 2 }))).toMatchObject({ kind: "applied", focus: { kind: "choice", selected: 2 } });
    expect(heard).toEqual(["input Pro", "change Pro"]);
    await applyInput(pane, request({ kind: "choose", index: 1 }));
    expect(select.selectedIndex).toBe(2);
    expect(heard).toHaveLength(2);
  });
});

describe("an input the page took too long for", () => {
  const settle = () => vi.advanceTimersByTimeAsync(0);

  it("sends nothing more once the phone has been told, so it never lands later on a page that may have changed", async () => {
    pane.hit = document.body;
    const answer = pane.stick("Page.getLayoutMetrics");
    const late = new AbortController();
    const applying = applyInput(pane, tap(393, 283), late.signal).catch((error: Error) => error.message);
    await settle();
    late.abort(new Error("late"));
    answer();
    expect(await applying).toBe("late");
    expect(pane.sent.map(({ method }) => method)).toEqual(["Page.getLayoutMetrics"]);
  });

  it("still releases a press it had sent, so the page is not left with a button held down, and sends nothing after", async () => {
    pane.hit = document.body;
    const answer = pane.stick("Input.dispatchMouseEvent", "mousePressed");
    const late = new AbortController();
    const applying = applyInput(pane, tap(393, 283), late.signal).catch((error: Error) => error.message);
    await settle();
    late.abort(new Error("late"));
    answer();
    expect(await applying).toBe("late");
    expect(pane.input().map(({ params }) => params["type"])).toEqual(["mousePressed", "mouseReleased"]);
    expect(pane.sent.at(-1)?.method).toBe("Input.dispatchMouseEvent");
  });
});

describe("the Mac's focus after an input", () => {
  const focusOf = async (html: string) => {
    document.body.innerHTML = html;
    (document.getElementById("f") as HTMLElement).focus();
    const answer = await applyInput(pane, request({ kind: "key", key: "Tab", count: 1 }));
    return answer.kind === "applied" ? answer.focus : answer;
  };
  const text = { kind: "text", keyboard: "default", enter: "default", secure: false, multiline: false };

  it("is a field to type into, with the keyboard and return key its element asks for", async () => {
    expect(await focusOf(`<input id="f">`)).toEqual(text);
    expect(await focusOf(`<input id="f" type="email" enterkeyhint="go">`)).toEqual({ ...text, keyboard: "email", enter: "go" });
    expect(await focusOf(`<input id="f" type="password">`)).toEqual({ ...text, secure: true });
    expect(await focusOf(`<input id="f" type="search">`)).toEqual({ ...text, keyboard: "search", enter: "search" });
    expect(await focusOf(`<input id="f" type="text" inputmode="decimal">`)).toEqual({ ...text, keyboard: "decimal" });
    expect(await focusOf(`<input id="f" type="tel" enterkeyhint="send">`)).toEqual({ ...text, keyboard: "tel", enter: "send" });
    expect(await focusOf(`<textarea id="f"></textarea>`)).toEqual({ ...text, multiline: true });
    expect(await focusOf(`<div id="f" contenteditable="true" tabindex="0">x</div>`)).toEqual({ ...text, multiline: true });
  });

  it("is nothing for an element that takes no typing, a read-only or a disabled field", async () => {
    expect(await focusOf(`<button id="f">Go</button>`)).toBeNull();
    expect(await focusOf(`<input id="f" type="checkbox">`)).toBeNull();
    expect(await focusOf(`<input id="f" readonly>`)).toBeNull();
    expect(await focusOf(`<a id="f" href="/next">Next</a>`)).toBeNull();
  });

  it("reaches into an open shadow root", async () => {
    document.body.innerHTML = `<div id="host"></div>`;
    const root = document.getElementById("host")!.attachShadow({ mode: "open" });
    root.innerHTML = `<input id="inner" type="url">`;
    (root.getElementById("inner") as HTMLInputElement).focus();
    expect(await applyInput(pane, request({ kind: "text", text: "x" }))).toEqual({ kind: "applied", focus: { ...text, keyboard: "url" } });
  });

  it("reaches into a same-origin frame, and through a shadow root inside it", async () => {
    const view = framed(`<textarea id="notes"></textarea><div id="host"></div>`);
    (view.inner.getElementById("notes") as HTMLTextAreaElement).focus();
    expect(await applyInput(pane, request({ kind: "text", text: "x" }))).toEqual({ kind: "applied", focus: { ...text, multiline: true } });
    const root = view.inner.getElementById("host")!.attachShadow({ mode: "open" });
    root.innerHTML = `<input id="inner" type="password">`;
    (root.getElementById("inner") as HTMLInputElement).focus();
    expect(await applyInput(pane, request({ kind: "text", text: "x" }))).toEqual({ kind: "applied", focus: { ...text, secure: true } });
  });
});

describe("what a phone's click can raise on the Mac", () => {
  it("intercepts file pickers while a phone drives the pane, until 3 s after its last input", async () => {
    pane.hit = document.body;
    await applyInput(pane, tap(10, 10));
    await applyInput(pane, tap(20, 20));
    const choosers = () => pane.sent.filter(({ method }) => method === "Page.setInterceptFileChooserDialog").map(({ params }) => params);
    expect(choosers()).toEqual([{ enabled: true, cancel: true }]);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(choosers()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(choosers().at(-1)).toEqual({ enabled: false });
    await applyInput(pane, tap(10, 10));
    expect(choosers().at(-1)).toEqual({ enabled: true, cancel: true });
    expect(pane.sent.filter(({ method }) => method === "Page.enable")).toHaveLength(1);
  });

  it("answers alert, confirm, prompt and print at once on the page a phone drives, and leaves them to the page 3 s after its last input", async () => {
    const page = pane.load();
    pane.hit = document.body;
    await applyInput(pane, tap(10, 10));
    expect(page.dialogs()).toEqual([undefined, false, null, undefined]);
    expect(page.shown).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    await applyInput(pane, tap(10, 10));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(page.dialogs()).toEqual([undefined, false, null, undefined]);
    await vi.advanceTimersByTimeAsync(1);
    expect(page.dialogs()).toEqual([undefined, true, "typed", undefined]);
    expect(page.shown).toEqual(["alert", "confirm", "prompt", "print"]);
    // Each input's registration replaces the last one's: new documents run one.
    expect(pane.scripts.size).toBe(1);
  });

  it("answers them on the page a tap navigates to, which starts with none of the last page's state", async () => {
    pane.load();
    pane.hit = document.body;
    await applyInput(pane, tap(10, 10));
    await vi.advanceTimersByTimeAsync(800);
    // The tap followed a link, and the next page alerts as it loads.
    const next = pane.load();
    expect(next.dialogs()).toEqual([undefined, false, null, undefined]);
    expect(next.shown).toEqual([]);
  });

  it("answers them at any time while the page is not shown on the Mac, where Electron's box would hold the whole app", async () => {
    pane.hit = document.body;
    await applyInput(pane, tap(10, 10));
    // A slow fetch, then a dialog long after the phone's last input.
    await vi.advanceTimersByTimeAsync(60_000);
    const hidden = pane.load("hidden");
    expect(hidden.dialogs()).toEqual([undefined, false, null, undefined]);
    expect(hidden.shown).toEqual([]);
    // Shown on the Mac, the dialog is a sheet on its window, which holds nothing: it is the page's.
    const shown = pane.load("visible");
    expect(shown.dialogs()).toEqual([undefined, true, "typed", undefined]);
  });
});
