import { useEffect } from "react";
import { TopBar } from "../components/TopBar";
import { useRpc } from "../lib/client";
import { useRouter } from "../lib/router";
import { ProjectSettings } from "./project-settings";

/** A project's settings under its name and folder. Its tasks are on the Tasks screen, under the sidebar's project filter. */
export function ProjectView({ projectId }: { projectId: string }) {
  const project = useRpc("projects.get", { id: projectId });
  const p = project.data;
  const removed = project.isSuccess && !p;
  // A project removed while its page shows gives way to a new thread, leaving no blank page or step back to it.
  useEffect(() => {
    if (removed) useRouter.getState().show({ view: "newthread" });
  }, [removed]);
  if (!p) return null;
  return (
    <>
      <TopBar>
        <h1 className="inline-flex h-7 shrink-0 items-center px-1 text-ink">{p.name}</h1>
        <span className="text-sm text-ink-4 font-mono truncate">{p.rootPath}</span>
      </TopBar>
      <ProjectSettings projectId={p.id} />
    </>
  );
}
