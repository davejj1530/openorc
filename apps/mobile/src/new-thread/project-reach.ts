import { useLinkState } from "../client";
import { linkReason } from "../connection/link-reason";
import type { ProjectChoice } from "../projects";

/** Why nothing can start on the Mac now, in the words the thread screen uses, or null while the phone reaches it. */
export const useMacReach = (): string | null => linkReason(useLinkState());

/**
 * Why a thread in this project cannot start now for want of the Mac (`macReach`), or null: Workspace and the Mac's
 * folders need it, a project only OpenOrc Cloud has never does.
 */
export const projectReach = (project: ProjectChoice, macReach: string | null): string | null => (project.cloud ? null : macReach);
