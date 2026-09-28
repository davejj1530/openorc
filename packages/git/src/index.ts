export { git, run, GitError, type ExecOptions, type ExecResult } from "./exec.js";
export { isGitRepo, repoInfo, defaultBranch, fetch, revParse, changedFiles, patchAgainst, log, isDirty, type RepoInfo } from "./repo.js";
export * as worktree from "./worktree.js";
export { treeHash, diffStat, patchSinceTree, switchFiles } from "./snapshot.js";
export { pinObject, unpinAll } from "./refs.js";
export { diskUsage } from "./disk.js";
export { commitAll, push, unpushedCommits, hasGh, createPr, type UnpushedCommits } from "./publish.js";
export * as teamTransfer from "./team-transfer.js";
export type { TeamTreeEntry, TeamTreeSnapshot, TeamMergeResult, TreeDeltaEntry } from "./team-transfer.js";
