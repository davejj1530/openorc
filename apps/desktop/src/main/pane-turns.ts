/** What may act on a pane: the agent's command or a phone's input. */
export type TurnHolder = "agent" | "phone";

/** Whatever acts on a pane now, and when it is done. */
const turns = new WeakMap<object, { holder: TurnHolder; done: Promise<void> }>();

export type Turn<T> = { ok: true; value: T } | { ok: false; holder: TurnHolder };

/** Resolves true when `done` settles first, false at the deadline. */
function settlesBy(done: Promise<void>, deadline: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => (timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()))));
  return Promise.race([done.then(() => true), late]).finally(() => clearTimeout(timer));
}

/**
 * Runs `work` once nothing else acts on the pane, waiting at most `waitMs` for what does: one at a time, so a phone's
 * tap never lands between an agent's snapshot and its click, nor an agent's click inside a phone's drag. Waiters go in
 * the order they came. `{ ok: false }` is a wait that ran out, with what held the pane then; `work` then never runs.
 */
export async function takeTurn<T>(pane: object, work: () => Promise<T>, waitMs: number, holder: TurnHolder): Promise<Turn<T>> {
  const deadline = Date.now() + waitMs;
  // Checked and taken in one step after each wake, so two waiters woken by the same end never both go.
  for (let current = turns.get(pane); current; current = turns.get(pane)) {
    if (!(await settlesBy(current.done, deadline))) return { ok: false, holder: current.holder };
  }
  let end!: () => void;
  turns.set(pane, { holder, done: new Promise((resolve) => (end = resolve)) });
  try {
    return { ok: true, value: await work() };
  } finally {
    turns.delete(pane);
    end();
  }
}
