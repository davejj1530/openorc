import { HOSTED_FILES_UNAVAILABLE, type HostedAvailability, type TeamChatFile } from "@openorc/protocol";
import type { HostedDeps } from "./index.js";
import { Refused, Superseded, Unreadable, type Session } from "./session.js";
import type { Spaces } from "./spaces.js";
import { FILE_ROUTES, type UploadPlan } from "./wire-files.js";
import { putFilePart, type FileByteSource } from "./file-transfer.js";
import { SOCKET, wireTopics } from "./wire.js";
import { PARITY_ROUTES } from "./wire-parity.js";

export type FileDestination = { kind: "hosted"; projectId: string; threadId?: string } | { kind: "chat"; conversationId: string };
export interface CloudFileScope {
  accountId: string;
  apiOrigin: string;
  spaceId: string;
  destination: FileDestination;
}
export interface CloudFileReference {
  id: string;
  name: string;
}
type Dependencies = Pick<HostedDeps, "fetch" | "push"> & { session: Session; spaces: Spaces };
const SESSION_CHANGED = "Your OpenOrc session changed. Try again.";

/** Shared upload and authorized-read transport. The host owns durable source bytes and draft state. */
export class Files {
  readonly #active = new Map<AbortController, "read" | "upload">();
  #generation: number;
  #closed = false;

  constructor(private readonly deps: Dependencies) {
    this.#generation = deps.session.generation;
    deps.session.onChange(() => {
      if (this.#generation === deps.session.generation) return;
      this.#generation = deps.session.generation;
      this.#abort();
      deps.push({ type: "invalidate", keys: ["hostedFiles", "hostedAssets"] });
    });
    deps.session.onSocket(SOCKET.changed, (body) => {
      const notice = wireTopics.safeParse(body);
      if (!notice.success || !notice.data.topics.some((topic) => ["spaces", "projects", "members"].includes(topic))) return;
      this.#abort("read");
      deps.push({ type: "invalidate", keys: ["hostedFiles", "hostedAssets"] });
    });
  }

  /** Resolve a Mac presentation to its server project once, without changing the captured account or space. */
  async capture(scope: CloudFileScope): Promise<CloudFileScope> {
    const generation = this.#assert(scope);
    if (scope.destination.kind === "chat") return scope;
    const projects = await this.deps.spaces.projects(scope.spaceId);
    this.#assert(scope, generation);
    const id = scope.destination.projectId;
    const project = projects.find((row) => row.key === id || row.localProjectId === id || row.hostedProjectId === id);
    if (!project?.hostedProjectId) throw new Refused("This project isn't available in this space.");
    return { ...scope, destination: { ...scope.destination, projectId: project.hostedProjectId } };
  }

  async start(scope: CloudFileScope, file: { name: string; bytes: number; requestId: string }, signal?: AbortSignal): Promise<UploadPlan> {
    const destination = scope.destination.kind === "hosted" ? { to: "hosted" } : { conversationId: scope.destination.conversationId };
    return this.#transfer(scope, "upload", signal, async (cancel) => {
      const plan = await this.deps.session.in(scope.spaceId).request(FILE_ROUTES.start, { ...file, ...destination }, cancel);
      if (plan.parts !== Math.ceil(file.bytes / plan.partBytes)) throw new Unreadable();
      return plan;
    });
  }

  async availability(scope: CloudFileScope): Promise<HostedAvailability> {
    return this.#transfer(scope, "read", undefined, async (signal) => {
      try {
        const reply = await this.deps.session.in(scope.spaceId).request(PARITY_ROUTES.capabilities, undefined, signal);
        return reply.features.files ?? { available: false, reason: HOSTED_FILES_UNAVAILABLE };
      } catch (error) {
        if (error instanceof Refused && error.status === 404) return { available: false, reason: HOSTED_FILES_UNAVAILABLE };
        throw error;
      }
    });
  }

  async part(scope: CloudFileScope, plan: UploadPlan, part: number, source: FileByteSource, options: { signal: AbortSignal; progress(sent: number): void }): Promise<void> {
    if (!Number.isSafeInteger(part) || part < 1 || part > plan.parts || plan.parts !== Math.ceil(source.bytes / plan.partBytes)) throw new Unreadable();
    await this.#transfer(scope, "upload", options.signal, async (signal) => {
      const { urls } = await this.deps.session.in(scope.spaceId).request(FILE_ROUTES.parts(plan.id), { parts: [part] }, signal);
      if (urls.length !== 1 || urls[0]?.part !== part) throw new Unreadable();
      const offset = (part - 1) * plan.partBytes;
      await putFilePart({ fetch: this.deps.fetch, url: urls[0]!.url, source, offset, bytes: Math.min(plan.partBytes, source.bytes - offset), signal, progress: options.progress });
    });
  }

  async complete(scope: CloudFileScope, uploadId: string, signal?: AbortSignal): Promise<TeamChatFile> {
    return this.#transfer(scope, "upload", signal, (cancel) => this.deps.session.in(scope.spaceId).request(FILE_ROUTES.complete(uploadId), undefined, cancel));
  }

  async cancel(scope: CloudFileScope, uploadId: string, signal?: AbortSignal): Promise<void> {
    await this.#transfer(scope, "upload", signal, (cancel) => this.deps.session.in(scope.spaceId).request(FILE_ROUTES.cancel(uploadId), undefined, cancel));
  }

  /** Consume the stream here so sign-out and access invalidation can cancel it until its last byte. */
  async read<T>(scope: CloudFileScope, file: CloudFileReference, thumbnail: boolean, consume: (response: Response) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const path = fileReadPath(scope.destination, file, thumbnail);
    return this.#transfer(scope, "read", signal, async (cancel) => {
      const response = await this.deps.session.stream(scope.spaceId, path, cancel);
      try {
        return await consume(response);
      } finally {
        if (!response.body?.locked) await response.body?.cancel().catch(() => undefined);
      }
    });
  }

  close(): void {
    this.#closed = true;
    this.#abort();
  }

  async #transfer<T>(scope: CloudFileScope, kind: "read" | "upload", outside: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const generation = this.#assert(scope);
    const control = new AbortController();
    this.#active.set(control, kind);
    const signal = outside ? AbortSignal.any([outside, control.signal]) : control.signal;
    try {
      signal.throwIfAborted();
      const result = await run(signal);
      signal.throwIfAborted();
      this.#assert(scope, generation);
      return result;
    } catch (error) {
      signal.throwIfAborted();
      throw error;
    } finally {
      this.#active.delete(control);
    }
  }

  #assert(scope: CloudFileScope, generation = this.deps.session.generation): number {
    const state = this.deps.spaces.status();
    if (this.#closed || !this.deps.session.state.signedIn || generation !== this.deps.session.generation || state.state !== "ready") throw new Superseded(SESSION_CHANGED);
    if (state.userId !== scope.accountId || state.apiOrigin !== scope.apiOrigin) throw new Superseded(SESSION_CHANGED);
    if (!state.spaces.some((space) => space.id === scope.spaceId)) throw new Refused("You're not in this organization.");
    return generation;
  }

  #abort(kind?: "read" | "upload"): void {
    for (const [control, active] of this.#active) if (!kind || kind === active) control.abort(new Superseded(SESSION_CHANGED));
  }
}

function fileReadPath(destination: FileDestination, file: CloudFileReference, thumbnail: boolean): string {
  const id = encodeURIComponent(file.id);
  if (destination.kind === "chat") return `/chat/files/${id}${thumbnail ? "/thumbnail" : "?download=1"}`;
  return thumbnail ? `/hosted/thumbnails/${id}` : `/hosted/files/${id}/${encodeURIComponent(file.name)}?download=1`;
}
