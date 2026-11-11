import { useEffect } from "react";
import { PageTitle } from "../components/PageTitle";
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
        <PageTitle className="shrink-0">{p.name}</PageTitle>
        <span className="text-sm text-ink-4 font-mono truncate">{p.rootPath}</span>
      </TopBar>
      <ProjectSettings projectId={p.id} />
    </>
  );
}
