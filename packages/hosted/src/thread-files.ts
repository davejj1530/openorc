import type { Session } from "./session.js";
import { THREAD_FILE_ROUTES, type WireThreadFileNames, type WireThreadFileRead, type WireThreadFolder } from "./wire-thread-files.js";

/**
 * A cloud thread's files read from OpenOrc Cloud itself, for a device with no Mac to read them through: a folder, a
 * name search, a file, and a binary file's bytes. Each read is made in the thread's space and is read-only; none wakes
 * the thread's machine.
 */
export class CloudThreadFiles {
  constructor(private readonly deps: { session: Session }) {}

  list(space: string, threadId: string, path: string): Promise<WireThreadFolder> {
    return this.deps.session.in(space).request(THREAD_FILE_ROUTES.list(threadId, path));
  }

  search(space: string, threadId: string, query: string, limit: number): Promise<WireThreadFileNames> {
    return this.deps.session.in(space).request(THREAD_FILE_ROUTES.search(threadId, query, limit));
  }

  read(space: string, threadId: string, path: string): Promise<WireThreadFileRead> {
    return this.deps.session.in(space).request(THREAD_FILE_ROUTES.read(threadId, path));
  }

  /** The bytes as a response its caller consumes, under its own cancellation. */
  raw(space: string, threadId: string, path: string, signal: AbortSignal): Promise<Response> {
    return this.deps.session.stream(space, THREAD_FILE_ROUTES.raw(threadId, path), signal);
  }
}
