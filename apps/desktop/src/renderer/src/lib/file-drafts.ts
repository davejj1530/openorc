import { create } from "zustand";
import { FileVersion } from "@openorc/protocol";

/**
 * Unsaved editor text, kept on this device so it survives tab switches, a closed panel, navigation and a restart.
 * IndexedDB, like the composer's image drafts: localStorage's quota would fill after two 2 MB buffers.
 *
 * Keyed by the file, not the conversation: the folder's real path and the file's place in it, as a read names them.
 * Conversations sharing a checkout share the draft, since the editor is a copy of the user's own file. A conversation
 * that moves to another folder finds that folder's drafts, and its old ones wait under the old folder's key.
 */

/** One file in one folder. Names its draft and its editor session. */
export type FileKey = string & { readonly __brand: "FileKey" };

export function fileKey(file: { root: string; path: string }): FileKey {
  return JSON.stringify([file.root, file.path]) as FileKey;
}

/** Unsaved text, and the version of the file it was typed on. */
export interface Draft {
  text: string;
  base: FileVersion;
}

interface DraftsState {
  /** Files with a draft on this device, read once at startup, so a tab can show its dot before its draft loads. */
  keys: ReadonlySet<FileKey>;
  /** Whether `keys` has been read. Until then a draft can only be found by reading it. */
  ready: boolean;
  /** Drafts read so far: the draft, or null for none. A file missing here hasn't been read yet. */
  loaded: ReadonlyMap<FileKey, Draft | null>;
  /** The last write to this device's storage failed, so unsaved text would not survive a restart. The next write that lands clears it. */
  failed: boolean;
}

export const useDrafts = create<DraftsState>(() => ({ keys: new Set(), ready: false, loaded: new Map(), failed: false }));

const STORE = "drafts";
/** Typing reaches memory at once, and this device's storage this long after it pauses, or sooner when the window blurs or hides. */
const WRITE_DELAY_MS = 300;

const pending = new Map<FileKey, Draft | null>();
/** Files changed since startup, whose startup key reading is out of date. */
const touched = new Set<FileKey>();
const reading = new Map<FileKey, Promise<Draft | null>>();
let timer: ReturnType<typeof setTimeout> | undefined;
let database: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  return (database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("openorc-file-drafts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      database = undefined;
      reject(request.error ?? new Error("Drafts can't be stored on this device."));
    };
  }));
}

async function inStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | undefined): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = work(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request?.result);
    transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("Drafts can't be stored on this device."));
  });
}

const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));

/** The storage boundary: anything that isn't a draft, from an older build or a damaged store, reads as no draft. */
function parseDraft(value: unknown): Draft | null {
  if (!object(value) || typeof value["text"] !== "string") return null;
  const base = FileVersion.safeParse(value["base"]);
  return base.success ? { text: value["text"], base: base.data } : null;
}

/** `keys` changes only when a file gains or loses its draft, so typing doesn't re-render every tab's dot. */
function remember(key: FileKey, draft: Draft | null): void {
  useDrafts.setState((state) => {
    const loaded = new Map(state.loaded).set(key, draft);
    if (Boolean(draft) === state.keys.has(key)) return { loaded };
    const keys = new Set(state.keys);
    if (draft) keys.add(key);
    else keys.delete(key);
    return { loaded, keys };
  });
}

/** Reads one file's draft into `loaded`, once. Resolves with what memory then holds, so a newer edit wins over the read. */
export function loadDraft(key: FileKey): Promise<Draft | null> {
  const { loaded, ready, keys } = useDrafts.getState();
  const known = loaded.get(key);
  if (known !== undefined) return Promise.resolve(known);
  if (ready && !keys.has(key)) {
    remember(key, null);
    return Promise.resolve(null);
  }
  let read = reading.get(key);
  if (!read) {
    read = inStore("readonly", (store) => store.get(key))
      .then(parseDraft, () => null)
      .then((draft) => {
        reading.delete(key);
        if (!useDrafts.getState().loaded.has(key)) remember(key, draft);
        return useDrafts.getState().loaded.get(key) ?? null;
      });
    reading.set(key, read);
  }
  return read;
}

/** Sets or, with null, drops a file's draft: in memory at once, on this device within WRITE_DELAY_MS. */
export function putDraft(key: FileKey, draft: Draft | null): void {
  touched.add(key);
  pending.set(key, draft);
  remember(key, draft);
  timer ??= setTimeout(() => void flushDrafts(), WRITE_DELAY_MS);
}

/** Writes every pending draft now. Runs on window blur, when the page hides, on pagehide, and when an editor blurs or unmounts. */
export async function flushDrafts(): Promise<void> {
  clearTimeout(timer);
  timer = undefined;
  if (pending.size === 0) return;
  const batch = new Map(pending);
  pending.clear();
  try {
    await inStore("readwrite", (store) => {
      for (const [key, draft] of batch) {
        if (draft) store.put(draft, key);
        else store.delete(key);
      }
      return undefined;
    });
    if (useDrafts.getState().failed) useDrafts.setState({ failed: false });
  } catch {
    for (const [key, draft] of batch) if (!pending.has(key)) pending.set(key, draft);
    useDrafts.setState({ failed: true });
  }
}

/** Every key in the store was made by fileKey. */
const storedKey = (key: IDBValidKey): key is FileKey => typeof key === "string";

function readKeys(): void {
  void inStore("readonly", (store) => store.getAllKeys()).then(
    (stored = []) => {
      const startup = stored.filter(storedKey).filter((key) => !touched.has(key));
      useDrafts.setState((state) => ({ ready: true, keys: new Set([...startup, ...state.keys]) }));
    },
    () => useDrafts.setState({ ready: true }),
  );
}

if (typeof window !== "undefined") {
  readKeys();
  window.addEventListener("blur", () => void flushDrafts());
  window.addEventListener("pagehide", () => void flushDrafts());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushDrafts();
  });
}
