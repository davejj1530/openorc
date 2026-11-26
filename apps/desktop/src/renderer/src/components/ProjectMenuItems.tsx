import { Menu } from "@base-ui/react/menu";
import type { Project } from "@openorc/protocol";
import { useScrollEdges } from "../lib/use-scroll-edges";
import { menuItem } from "./menu";
import { ProjectLogo } from "./ProjectIconPicker";

/** Projects to choose from inside a menu, each by its icon and name, scrolling on their own once they run past the project picker's height. */
export function ProjectMenuItems({ projects, onSelect }: { projects: readonly Project[]; onSelect: (projectId: string) => void }) {
  const edges = useScrollEdges();
  return (
    <div {...edges} className="project-menu-items scroll-edges">
      {projects.map((project) => (
        <Menu.Item key={project.id} className={menuItem} onClick={() => onSelect(project.id)}>
          <span className="sidebar-scope-icon">
            <ProjectLogo project={project} size={18} />
          </span>
          <span className="sidebar-scope-name">{project.name}</span>
        </Menu.Item>
      ))}
    </div>
  );
}
