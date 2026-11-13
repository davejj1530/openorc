import { WORKSPACE_ID, type ClaudeAccountConnection, type ClaudeAccounts, type Project } from "@openorc/protocol";

/** What a project's own Claude accounts need of it; older hosts send projects without them. */
export type AccountsProject = Pick<Project, "id"> & { settings?: Pick<Project["settings"], "claudeAccounts"> };

/** The Claude accounts a thread in a project may choose from, and the one it starts on. */
export interface ProjectAccountChoice {
  /** Whether the project uses only some accounts. */
  restricted: boolean;
  accounts: ClaudeAccountConnection[];
  defaultId: string;
}

/**
 * The accounts a project's threads can choose, as the host decides them (it still has the last word): a project that
 * uses only some accounts offers those that are enabled, starting on its default while that is one of them, else on
 * the first; any other project, the Workspace and an unknown one offer the app's list and default as they are.
 */
export function projectAccountChoice(project: AccountsProject | null | undefined, list: ClaudeAccounts): ProjectAccountChoice {
  const own = project && project.id !== WORKSPACE_ID ? project.settings?.claudeAccounts : null;
  if (!own?.only) return { restricted: false, accounts: list.accounts, defaultId: list.defaultId };
  const accounts = list.accounts.filter((account) => account.enabled && own.accountIds.includes(account.id));
  const defaultId = accounts.some((account) => account.id === own.defaultId) ? own.defaultId! : (accounts[0]?.id ?? list.defaultId);
  return { restricted: true, accounts, defaultId };
}

/**
 * The account chosen for a new thread or schedule while the choice offers it; undefined, so the project's default runs,
 * for one a project that uses only some accounts does not use. Before the choice is known, the chosen one stands.
 */
export function offeredAccount(choice: ProjectAccountChoice | undefined, chosen: string | undefined): string | undefined {
  return choice?.restricted && !choice.accounts.some((account) => account.id === chosen) ? undefined : chosen;
}
