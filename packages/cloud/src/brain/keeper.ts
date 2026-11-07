import path from "node:path";
import { BRAIN_EXIT, BRAIN_READY, type BrainLayout } from "./layout.js";
import type { BrainStartCommand } from "./machine.js";

/** A brain that keeps stopping on its own is left down after this many starts again within `KEEP_WINDOW_S`. */
export const KEEP_RESTARTS = 5;
export const KEEP_WINDOW_S = 600;

/** Exits the brain chose, or a start refused: none of them is started again. */
const CHOSEN = [0, BRAIN_EXIT.badStart, BRAIN_EXIT.alreadyRunning, BRAIN_EXIT.wrongKey, BRAIN_EXIT.needsProvision];

/**
 * The keeper, in a session of its own with nothing piped back to whoever started it: it holds the start line it read
 * once, runs the brain under its lock, and runs it again after an exit the brain did not choose, as a crash or a kill.
 * The first start's ready line, or its exit and stderr, go to `$5` for the launcher to pass on; a first start that
 * fails is not retried, since the wake reports it. Each exit after that is added to the keeper's log, `$4`.
 * $1 the brain's entry, $2 its lock, $3 the keeper's lock, $4 the keeper's log, $5 this start's files.
 */
export const KEEP_SCRIPT = [
  `IFS= read -r start || exit ${BRAIN_EXIT.badStart}`,
  "umask 077",
  'exec 9>"$3"',
  `flock -n 9 || { printf '%s\\n' ${BRAIN_EXIT.alreadyRunning} > "$5.part" && mv "$5.part" "$5.code"; exit 0; }`,
  'log="$4"',
  'mkdir -p "${log%/*}" 2>/dev/null',
  // A log it cannot write must not end the keeper.
  `say() { { printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$log"; } 2>/dev/null || :; }`,
  'first="$5"',
  'starts=""',
  "while :; do",
  '  if [ -n "$first" ]; then out="$first.out" err="$first.err"; else out=/dev/null err="$log"; fi',
  `  printf '%s\\n' "$start" | flock -n -E ${BRAIN_EXIT.alreadyRunning} "$2" node "$1" serve > "$out" 2>> "$err" 9>&-`,
  "  code=$?",
  '  if [ -n "$first" ]; then',
  `    if ! grep -q '^${BRAIN_READY} ' "$first.out" 2>/dev/null; then printf '%s\\n' "$code" > "$first.part" && mv "$first.part" "$first.code"; exit 0; fi`,
  '    rm -f "$first.out" "$first.err"',
  '    first=""',
  "  fi",
  '  case "$code" in',
  `    ${CHOSEN.join("|")}) say "The brain stopped (exit $code)."; exit 0 ;;`,
  "  esac",
  "  now=$(date +%s)",
  `  kept=""; for at in $starts; do [ $((now - at)) -lt ${KEEP_WINDOW_S} ] && kept="$kept $at"; done; starts="$kept $now"`,
  `  if [ "$(echo $starts | wc -w)" -gt ${KEEP_RESTARTS} ]; then say "The brain stopped (exit $code), its ${KEEP_RESTARTS + 1}th time in ${KEEP_WINDOW_S / 60} minutes; it stays down."; exit 0; fi`,
  '  say "The brain stopped (exit $code); starting it again."',
  "  sleep 2",
  "done",
].join("\n");

/**
 * Starts the keeper with the start line read from stdin, then answers as a start of the brain itself would: the first
 * start's ready line on stdout, or its exit code and stderr. It stays a moment after the ready line, so whoever
 * started it reads that line before the exit.
 * $1 the brain's folder, $2 its entry, $3 its lock, $4 the keeper's lock, $5 the keeper's log, $6 the keeper.
 */
export const LAUNCH_SCRIPT = [
  `IFS= read -r start || exit ${BRAIN_EXIT.badStart}`,
  `cd "$1" 2>/dev/null && test -e "$2" && test -d "\${3%/*}" || exit ${BRAIN_EXIT.needsProvision}`,
  "umask 077",
  'files="${3%/*}/start.$$"',
  'rm -f "$files.out" "$files.err" "$files.code"',
  `printf '%s\\n' "$start" | setsid sh -c "$6" brain-keeper "$2" "$3" "$4" "$5" "$files" > /dev/null 2>&1 &`,
  "while :; do",
  `  if grep -q '^${BRAIN_READY} ' "$files.out" 2>/dev/null; then cat "$files.out"; sleep 3; exit 0; fi`,
  '  if [ -e "$files.code" ]; then',
  '    cat "$files.err" >&2 2>/dev/null',
  '    code=$(cat "$files.code")',
  '    rm -f "$files.out" "$files.err" "$files.code"',
  '    exit "$code"',
  "  fi",
  "  sleep 0.2",
  "done",
].join("\n");

/** Where the keeper keeps its lock and its log, beside the brain's own. */
export function keeperPaths(layout: BrainLayout): { lock: string; log: string } {
  return { lock: path.posix.join(layout.run, "keeper.lock"), log: path.posix.join(layout.logs, "keeper.log") };
}

/** The brain's start under a keeper, its start line on stdin as for the plain start. */
export function keptStart(layout: BrainLayout): BrainStartCommand {
  const keeper = keeperPaths(layout);
  return { cmd: "sh", args: ["-c", LAUNCH_SCRIPT, "brain-start", layout.root, layout.serve, layout.lock, keeper.lock, keeper.log, KEEP_SCRIPT] };
}
