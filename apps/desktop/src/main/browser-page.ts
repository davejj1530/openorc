import type { WebContents } from "electron";
import type { BrowserCommand, BrowserSnapshot } from "@openorc/protocol";

/** Runs only in the preview's isolated world. No agent-supplied JavaScript is evaluated. */
function pageOperation(command: BrowserCommand): BrowserSnapshot | { x: number; y: number } | { refused: "password" } | null {
  const world = globalThis as typeof globalThis & { __openorcRefs?: Map<string, HTMLElement> };
  const visible = (el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const fieldValue = (element: HTMLElement): string | undefined => {
    if (element instanceof HTMLInputElement) return element.type === "password" ? undefined : element.value;
    if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return element.value;
    return undefined;
  };
  const fieldPrototype = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) => {
    if (element instanceof HTMLInputElement) return HTMLInputElement.prototype;
    if (element instanceof HTMLTextAreaElement) return HTMLTextAreaElement.prototype;
    return HTMLSelectElement.prototype;
  };
  if (command.action === "snapshot") {
    const refs = new Map<string, HTMLElement>();
    world.__openorcRefs = refs;
    // Unlike randomUUID(), getRandomValues also works on public HTTP pages.
    const prefix = Array.from(crypto.getRandomValues(new Uint32Array(4)), (part) => part.toString(16)).join("-");
    const elements: BrowserSnapshot["elements"] = [];
    const scan = (root: Document | ShadowRoot) => {
      for (const el of Array.from(root.querySelectorAll<HTMLElement>("*")).slice(0, 10000)) {
        if (elements.length >= 200) break;
        if (el.shadowRoot) scan(el.shadowRoot);
        if (!el.matches("a[href],button,input,textarea,select,summary,[role],[tabindex],[contenteditable=true]") || !visible(el)) continue;
        const ref = `${prefix}:${elements.length + 1}`;
        refs.set(ref, el);
        const labels =
          "labels" in el
            ? Array.from((el as HTMLInputElement).labels ?? [])
                .map((label) => label.textContent ?? "")
                .join(" ")
            : "";
        const labelled = (el.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/)
          .map((id) => root.getElementById(id)?.textContent ?? "")
          .join(" ")
          .trim();
        const name = el.getAttribute("aria-label") || labelled || labels || el.innerText || el.getAttribute("placeholder") || el.getAttribute("title") || "";
        const value = fieldValue(el);
        elements.push({ ref, tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), name: name.trim().slice(0, 300), ...(value !== undefined ? { value: value.slice(0, 1000) } : {}) });
      }
    };
    scan(document);
    return { text: (document.body?.innerText ?? "").slice(0, 16000), elements, viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY } };
  }
  if (command.action === "scroll") {
    window.scrollBy({ left: command.x, top: command.y, behavior: "instant" });
    return null;
  }
  if (command.action !== "click" && command.action !== "fill") return null;
  const target = world.__openorcRefs?.get(command.ref);
  if (!target?.isConnected || !visible(target)) throw new Error("This element is stale or hidden. Take a fresh snapshot.");
  if (target.matches(":disabled,[aria-disabled=true]") || target.closest("[inert]")) throw new Error("This element is disabled.");
  target.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  if (command.action === "click") {
    const rect = target.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth - 1, rect.x + rect.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, rect.y + rect.height / 2));
    let hit = document.elementFromPoint(x, y);
    while (hit?.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    if (!hit || (hit !== target && !target.contains(hit))) throw new Error("This element is covered by another element.");
    return { x, y };
  }
  // A password is typed only once the user allowed it for this field.
  if (target instanceof HTMLInputElement && target.type === "password" && !command.secret) return { refused: "password" };
  target.focus();
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
    if ("readOnly" in target && target.readOnly) throw new Error("This field is read-only.");
    if (target instanceof HTMLInputElement && ["file", "checkbox", "radio", "button", "submit", "reset", "hidden"].includes(target.type))
      throw new Error("Use click for this control; file uploads are not supported.");
    const prototype = fieldPrototype(target);
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(target, command.text);
  } else if (target.isContentEditable) target.textContent = command.text;
  else throw new Error("This element is not an editable field.");
  target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  target.dispatchEvent(new Event("change", { bubbles: true }));
  return null;
}

const worldId = 1001;
export async function inspectPage(contents: WebContents): Promise<BrowserSnapshot> {
  return runPage(contents, { action: "snapshot" }) as Promise<BrowserSnapshot>;
}

function runPage(contents: WebContents, command: BrowserCommand): Promise<unknown> {
  return contents.executeJavaScriptInIsolatedWorld(worldId, [{ code: `(${pageOperation.toString()})(${JSON.stringify(command)})` }], true);
}

/** Returns what the page refused, such as a password field the user has not allowed, or null when the input went in. */
export async function interactWithPage(contents: WebContents, command: BrowserCommand): Promise<"password" | null> {
  // sendInputEvent requires OS window focus. CDP targets this preview directly,
  // including a background conversation, without focusing the user's window.
  const input = async (method: string, params: object) => {
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    await contents.debugger.sendCommand(method, params);
  };
  if (command.action === "press") {
    const codes = { Enter: 13, Tab: 9, Escape: 27, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Backspace: 8, Space: 32 };
    const key = command.key === "Space" ? " " : command.key;
    const text = keyText(command.key);
    const keyEvent = { key, code: command.key, windowsVirtualKeyCode: codes[command.key], nativeVirtualKeyCode: codes[command.key] };
    await input("Input.dispatchKeyEvent", { type: "keyDown", ...keyEvent, ...(text ? { text } : {}) });
    await input("Input.dispatchKeyEvent", { type: "keyUp", ...keyEvent });
  } else {
    const outcome = (await runPage(contents, command)) as { x: number; y: number } | { refused: "password" } | null;
    if (outcome && "refused" in outcome) return outcome.refused;
    const point = outcome;
    if (command.action === "click" && point) {
      const position = { x: Math.round(point.x), y: Math.round(point.y) };
      await input("Input.dispatchMouseEvent", { type: "mouseMoved", ...position });
      await input("Input.dispatchMouseEvent", { type: "mousePressed", ...position, button: "left", clickCount: 1 });
      await input("Input.dispatchMouseEvent", { type: "mouseReleased", ...position, button: "left", clickCount: 1 });
    }
  }
  // Let input handlers and a navigation they trigger start before reading back.
  await new Promise((resolve) => setTimeout(resolve, 80));
  return null;
}

export async function waitForPage(contents: WebContents): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!contents.isDestroyed() && contents.isLoadingMainFrame()) {
    if (Date.now() > deadline) throw new Error("The preview is still loading. Check the website and retry.");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (contents.isDestroyed()) throw new Error("The preview was closed. Open it again.");
}

function keyText(key: string): string | undefined {
  if (key === "Enter") return "\r";
  if (key === "Space") return " ";
  return undefined;
}
