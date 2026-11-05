import { closeDoor, openDoor, removeDoor, vercelDenied, type DoorAccess, type DoorBundle, type DoorOpening } from "@openorc/cloud";
import type { CloudBrainDoor } from "@openorc/protocol";

/** How the Mac reaches the brain's door on Vercel. Tests pass stand-ins; everyone else the REST calls. */
export interface BrainDoors {
  open: typeof openDoor;
  close: typeof closeDoor;
  remove: typeof removeDoor;
}

export const vercelDoors: BrainDoors = { open: openDoor, close: closeDoor, remove: removeDoor };

/**
 * The brain's door as this Mac keeps it: deployed with the Mac's own wake, current with this build and the Vercel
 * connection, and gone before the token it holds is. Never wakes the brain. Its callers serialize it with the brain's
 * other operations.
 */
export class BrainDoorKeeper {
  private state: CloudBrainDoor | null = null;
  /** The mark opened and tidied since this Mac started: while the door answers with it, one look is all. */
  private tidied: string | null = null;

  constructor(
    private readonly deps: {
      doors: BrainDoors;
      /** The door's project; DOOR_PROJECT unless given. */
      project: string | undefined;
      changed(): void;
      scrub(error: unknown): Promise<string>;
    },
  ) {}

  status(): CloudBrainDoor | null {
    return this.state;
  }

  /** Brings the door to this config and code. A failure is kept for Settings, not thrown. */
  async open(access: Omit<DoorAccess, "project">, opening: DoorOpening, bundle: DoorBundle): Promise<void> {
    try {
      const opened = await this.deps.doors.open(this.at(access), opening, bundle, { tidied: this.tidied, deploying: () => this.show({ state: "opening" }) });
      this.tidied = opened.mark;
      this.show({ state: "open" });
    } catch (error) {
      this.tidied = null;
      this.show({ state: "failed", error: await this.deps.scrub(error) });
    }
  }

  /**
   * Deletes the door's deployments and its copy of the token, before the Mac forgets the Vercel connection. A token
   * Vercel refuses has nothing left to delete with, and nothing to guard.
   */
  async close(access: Omit<DoorAccess, "project">): Promise<void> {
    try {
      await this.deps.doors.close(this.at(access));
    } catch (error) {
      if (!vercelDenied(error)) throw new Error(`Could not close the cloud brain's door. ${await this.deps.scrub(error)}`);
    }
    this.forget();
  }

  /** Deletes each of the door's deployments, then its project. As for closing, a token Vercel refuses lets it be. */
  async remove(access: Omit<DoorAccess, "project">): Promise<void> {
    try {
      await this.deps.doors.remove(this.at(access));
    } catch (error) {
      if (!vercelDenied(error)) throw new Error(`Could not remove the cloud brain's door. ${await this.deps.scrub(error)}`);
    }
    this.forget();
  }

  private forget(): void {
    this.tidied = null;
    this.show(null);
  }

  private at(access: Omit<DoorAccess, "project">): DoorAccess {
    return this.deps.project ? { ...access, project: this.deps.project } : access;
  }

  private show(state: CloudBrainDoor | null): void {
    this.state = state;
    this.deps.changed();
  }
}
