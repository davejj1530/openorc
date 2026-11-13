import { claudeAccounts, projects, type Db } from "@openorc/db";
import { WORKSPACE_ID, type AppSettings, type ProjectClaudeAccounts } from "@openorc/protocol";
import { AppSettingsService } from "./settings.js";

/**
 * Which Claude accounts a project's threads may use. A project that keeps its own (`restricted`) allows the selected
 * accounts that still exist and are enabled; any other project, and the Workspace, allows every enabled account and
 * follows the app's default and its switch at usage limits, as before projects had accounts of their own.
 */
export interface ProjectAccountPolicy {
  restricted: boolean;
  /** Enabled accounts, in the order the app lists them. Empty when none of a restricted project's accounts is usable. */
  allowed: string[];
  /** New threads' account: the project's default while it is allowed, else its first allowed account. */
  defaultId: string;
  /** Whether a thread that reaches its account's usage limit goes on with another allowed account. */
  autoSwitch: boolean;
}

/**
 * Where a starting thread's account came from, which decides what happens when the project does not use it. "unused"
 * is a thread that is not Claude's: its account only goes along, so it is never refused and never stops the start.
 */
export type AccountSource = "chosen" | "inherited" | "own" | "unused";

export const NO_PROJECT_ACCOUNTS = "None of this project's Claude accounts are enabled. Choose one in the project's settings.";
export const NOT_A_PROJECT_ACCOUNT = "This project doesn't use that Claude account.";

/** The project's selection while it uses only those accounts; null while it follows the app's. */
function ownAccounts(db: Db, projectId: string): ProjectClaudeAccounts | null {
  if (projectId === WORKSPACE_ID) return null;
  const chosen = projects.get(db, projectId)?.settings.claudeAccounts;
  return chosen?.only ? chosen : null;
}

/**
 * The project's accounts as they stand: selected ids that were removed or disabled since are dropped as they are read,
 * never rewritten, so enabling an account again brings it back.
 */
export function projectAccountPolicy(db: Db, projectId: string, settings: Pick<AppSettings, "claudeAccountAutoSwitch"> = new AppSettingsService(db).get()): ProjectAccountPolicy {
  const enabled = claudeAccounts
    .list(db)
    .filter((account) => account.enabled)
    .map((account) => account.id);
  const own = ownAccounts(db, projectId);
  if (!own) return { restricted: false, allowed: enabled, defaultId: claudeAccounts.defaultId(db), autoSwitch: settings.claudeAccountAutoSwitch };
  const allowed = enabled.filter((id) => own.accountIds.includes(id));
  const defaultId = own.defaultId && allowed.includes(own.defaultId) ? own.defaultId : (allowed[0] ?? claudeAccounts.defaultId(db));
  return { restricted: true, allowed, defaultId, autoSwitch: own.autoSwitch };
}

/** Whether a thread in the project may start on, or move to, the account. A project that follows the app's allows any. */
export function allowsAccount(policy: ProjectAccountPolicy, id: string): boolean {
  return !policy.restricted || policy.allowed.includes(id);
}

/** The account a new thread starts on when it was given none, or none the project uses; an error when it has none. */
export function newThreadAccount(policy: ProjectAccountPolicy): string {
  if (policy.restricted && !policy.allowed.length) throw new Error(NO_PROJECT_ACCOUNTS);
  return policy.defaultId;
}

/** Says which accounts a restricted project uses, for a choice it does not allow. */
function onlyTheseAccounts(db: Db, policy: ProjectAccountPolicy): string {
  const names = new Map(claudeAccounts.list(db).map((account) => [account.id, account.name]));
  return `This project only uses these Claude accounts: ${policy.allowed.map((id) => names.get(id) ?? id).join(", ")}.`;
}

/**
 * The account a thread in the project starts on. With none asked for, the project's default (the app's for a project
 * that follows the app's). One a person chose that the project does not use is refused; one passed down from a parent,
 * a task or a schedule gives way to the project's default; a starter's own, as an Orcling's, is left alone. A thread
 * that is not Claude's starts even when none of the project's accounts is enabled.
 */
export function startingAccount(db: Db, projectId: string, requested: string | undefined, from: AccountSource = "chosen"): string {
  if (from === "own" && requested) return requested;
  const policy = projectAccountPolicy(db, projectId, { claudeAccountAutoSwitch: false });
  if (from === "unused") return requested && allowsAccount(policy, requested) ? requested : policy.defaultId;
  if (!requested) return newThreadAccount(policy);
  if (allowsAccount(policy, requested)) return requested;
  if (from === "inherited" || !policy.allowed.length) return newThreadAccount(policy);
  throw new Error(onlyTheseAccounts(db, policy));
}

/** Refuses a project's own accounts that could not work: none selected, unknown ones, a default outside them, or the Workspace. */
export function assertProjectAccounts(db: Db, projectId: string, chosen: ProjectClaudeAccounts | null | undefined): void {
  if (!chosen?.only) return;
  if (projectId === WORKSPACE_ID) throw new Error("The Workspace uses the app's Claude accounts.");
  if (!chosen.accountIds.length) throw new Error("Choose at least one Claude account for this project.");
  const known = new Set(claudeAccounts.list(db).map((account) => account.id));
  if (chosen.accountIds.some((id) => !known.has(id))) throw new Error("One of these Claude accounts is no longer available. Choose again.");
  if (!chosen.defaultId || !chosen.accountIds.includes(chosen.defaultId)) throw new Error("Choose this project's default Claude account from its accounts.");
}
