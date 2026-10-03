import { FolderGit2, GitPullRequest, ListTodo } from "./icons";

const starters = [
  { label: "Explore this project", icon: FolderGit2, prompt: "Walk me through this project. Explain how it is organized and where the main features live." },
  { label: "Plan a change", icon: ListTodo, prompt: "Help me plan a change to this project. Let's start by discussing what I want to build." },
  { label: "Review my changes", icon: GitPullRequest, prompt: "Review the current uncommitted changes. Look for bugs, regressions, and anything that needs attention." },
];

/** Starter actions prepare a draft; sending remains an explicit choice. */
export function NewThreadWelcome({ isWorkspace, hasProject, onStart }: { isWorkspace: boolean; hasProject: boolean; onStart: (prompt: string) => void }) {
  return (
    <div className="new-thread-welcome">
      <div className="new-thread-intro">
        <div className="document-eyebrow">
          <span className="document-type-mark" />A new thread
        </div>
        <h1>Start with an idea.</h1>
        <p>
          {isWorkspace
            ? "A question, a plan, or something you’d like to make. Choose a folder and take it from there."
            : "A question, a plan, or something you’d like to make. Your project is ready when you are."}
        </p>
        {hasProject && !isWorkspace ? (
          <div className="thread-starters">
            {starters.map(({ label, icon: Icon, prompt }) => (
              <button key={label} onClick={() => onStart(prompt)}>
                <Icon size={18} />
                <span>{label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
