import { WORKSPACE_ID } from "@openorc/protocol";
import type { ComponentType } from "react";
import { Cloud, Folder, FolderOpen, Globe } from "../generated/icons";
import type { ProjectChoice } from "../projects";
import type { IconProps } from "../ui/icon";

/** A project's glyph: the globe for Workspace, the cloud for one only OpenOrc Cloud has, as its group wears on Home, else a folder, open while chosen. */
export function projectIcon(choice: ProjectChoice, open: boolean): ComponentType<IconProps> {
  if (choice.id === WORKSPACE_ID) return Globe;
  if (choice.cloud) return Cloud;
  return open ? FolderOpen : Folder;
}
