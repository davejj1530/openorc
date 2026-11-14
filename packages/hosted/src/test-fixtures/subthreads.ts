import { createHosted } from "../index.js";
import { wireThreadDetail, wireThreadList } from "../wire.js";
import { standIn } from "../testing/stand-in.js";
import { hostDeps, newDevice, signInAs } from "./host.js";
import { Threads } from "../threads.js";

const email = "reader@example.com";
const at = "2026-01-01T00:00:00.000Z";

export async function subthreadFixture() {
  const server = await standIn({ signup: "open" });
  const root = server.addThread(email, { title: "Inspect example", projectId: null });
  const child = server.addThread(email, { title: "Inspect source", projectId: null, status: "working" });
  const nested = server.addThread(email, { title: "Check imports", projectId: null });
  const metadata = [
    {
      id: child,
      rootId: root,
      parentId: root,
      relation: "subagent",
      agent: "claude",
      title: "Inspect source",
      status: "running",
      agentType: "explore",
      toolCallId: "tool-a",
      startedAt: at,
      endedAt: null,
      stoppable: true,
      hostRunId: "host-one",
    },
    {
      id: nested,
      rootId: root,
      parentId: child,
      relation: "subagent",
      agent: "claude",
      title: "Check imports",
      status: "completed",
      agentType: null,
      toolCallId: "tool-b",
      startedAt: at,
      endedAt: at,
      stoppable: false,
      hostRunId: null,
    },
  ];
  const state = {
    metadataStatus: 200,
    metadataReads: 0,
    stopStatus: 204,
    lost: false,
    beforeReply: async () => {},
    omitRoot: false,
    hidden: new Set<string>(),
    frame: (_id: string): void => undefined,
  };
  const stops: { path: string; body: unknown; space: string | null }[] = [];
  const device = newDevice();
  const { deps, browser, seen } = hostDeps(server, device, {
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/subthreads")) {
        state.metadataReads++;
        await state.beforeReply();
        return Response.json(state.metadataStatus === 200 ? { children: metadata } : { message: "Could not read subthreads." }, { status: state.metadataStatus });
      }
      if (path.endsWith("/subagent/stop")) {
        stops.push({ path, body: typeof init?.body === "string" ? JSON.parse(init.body) : null, space: new Headers(init?.headers).get("x-openorc-space") });
        if (state.lost) throw new Error("Lost response");
        return state.stopStatus === 204 ? new Response(null, { status: 204 }) : Response.json({ message: "This subagent can't be stopped separately." }, { status: state.stopStatus });
      }
      const reply = await fetch(input, init);
      if (!reply.ok || (init?.method && init.method !== "GET")) return reply;
      const parent = (id: string) => metadata.find((row) => row.id === id)?.parentId ?? null;
      if (path === "/hosted/threads") {
        const data = wireThreadList.parse(await reply.json());
        return Response.json({ threads: data.threads.filter((row) => (!state.omitRoot || row.id !== root) && !state.hidden.has(row.id)).map((row) => ({ ...row, parentId: parent(row.id) })) });
      }
      if ([root, child, nested].some((id) => path === `/hosted/threads/${id}`)) {
        const data = wireThreadDetail.parse(await reply.json());
        return Response.json({ ...data, parentId: parent(data.id) });
      }
      return reply;
    },
  });
  const hosted = createHosted({
    ...deps,
    push: (push) => {
      if (push.type === "frame") for (const event of push.frame.events) if ((event.type === "subagent.started" || event.type === "subagent.updated") && event.threadId) state.frame(event.threadId);
      deps.push(push);
    },
  });
  if (!(hosted.threads instanceof Threads)) throw new Error("Expected the hosted thread transport.");
  const threads = hosted.threads;
  await hosted.start();
  await signInAs(hosted, browser, email);
  return { server, hosted, threads, root, child, nested, metadata, state, stops, device, seen, deps };
}
