import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { SlackFile, type SlackImageData } from "./images.js";
import { z } from "zod";
import { ApprovalSync, SlackApprovals, type ApprovalPage } from "./approvals.js";

export const ContextMessage = z.object({ id: z.string(), userId: z.string(), text: z.string(), at: z.number(), files: z.array(SlackFile).optional() });
type Conversation = { channelId: string; threadTs: string; deviceIds: string[]; messages: z.infer<typeof ContextMessage>[] };

export const SlackJob = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    userId: z.string(),
    channelId: z.string(),
    threadTs: z.string(),
    text: z.string().max(20_000),
    files: z.array(SlackFile).optional(),
    context: z.array(ContextMessage).optional(),
    messageTs: z.string().optional(),
    contextWarning: z.string().optional(),
  })
  .strict();
export type SlackJob = z.infer<typeof SlackJob>;
export const SlackResult = z.object({ id: z.string(), kind: z.enum(["waiting", "progress", "finished"]), text: z.string().max(12_000) }).strict();
export type SlackResult = z.infer<typeof SlackResult>;

/** Only bounded error codes cross the relay; SDK messages can contain credentials or message bodies. */
const SlackErrorCode = z.enum([
  "invalid_blocks",
  "invalid_blocks_format",
  "msg_too_long",
  "invalid_arguments",
  "message_not_found",
  "cant_update_message",
  "block_mismatch",
  "edit_window_closed",
  "missing_scope",
  "not_in_channel",
  "channel_not_found",
  "is_archived",
  "invalid_auth",
  "token_revoked",
  "account_inactive",
  "ratelimited",
  "request_timeout",
  "slack_api_error",
]);
const RelayFailure = z.object({ code: z.enum(["rejected", "job_mismatch", "invalid_request", "slack_delivery_failed"]), slackCode: SlackErrorCode.optional() });
export class RelayRequestError extends Error {
  constructor(
    readonly code: z.infer<typeof RelayFailure>["code"],
    readonly slackCode?: z.infer<typeof SlackErrorCode>,
  ) {
    super(relayFailureMessage(code, slackCode));
  }
}
function relayFailureMessage(code: z.infer<typeof RelayFailure>["code"], slackCode: z.infer<typeof SlackErrorCode> | undefined): string {
  if (code === "slack_delivery_failed") return `The relay is reachable, but Slack delivery failed (${slackCode ?? "slack_api_error"}). The reply is still pending.`;
  if (code === "job_mismatch") return "Relay rejected the pending reply because its job no longer matches. The local answer is preserved.";
  if (code === "invalid_request") return "Relay rejected an invalid request. The local answer is preserved.";
  return "Relay rejected the device key. Check this desktop's device registration.";
}
const failureStatus: Record<z.infer<typeof RelayFailure>["code"], number> = {
  slack_delivery_failed: 502,
  job_mismatch: 409,
  invalid_request: 400,
  rejected: 403,
};
function deliveryFailure(error: unknown): RelayRequestError {
  const data = z.object({ data: z.object({ error: SlackErrorCode }).optional(), code: z.string().optional() }).safeParse(error);
  if (!data.success) return new RelayRequestError("slack_delivery_failed", "slack_api_error");
  if (data.data.data?.error) return new RelayRequestError("slack_delivery_failed", data.data.data.error);
  if (data.data.code === "slack_webapi_rate_limited_error") return new RelayRequestError("slack_delivery_failed", "ratelimited");
  if (data.data.code === "slack_webapi_request_error") return new RelayRequestError("slack_delivery_failed", "request_timeout");
  return new RelayRequestError("slack_delivery_failed", "slack_api_error");
}
export interface RelayJournal {
  jobs: { deviceId: string; job: SlackJob; progressTs?: string }[];
  completed: Record<string, string>;
  conversations?: Conversation[];
  queued?: { deviceId: string; job: SlackJob }[];
}
export interface Device {
  id: string;
  userId: string;
  label: string;
  keyHash: string;
}
export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
export function newDevice(userId: string, label: string): { device: Device; deviceKey: string } {
  const deviceKey = `oqd_${randomBytes(32).toString("hex")}`;
  return { device: { id: randomUUID(), userId, label, keyHash: hashKey(deviceKey) }, deviceKey };
}

const Mention = z.object({
  event_id: z.string(),
  team_id: z.string(),
  event: z.object({
    type: z.enum(["app_mention", "message"]),
    user: z.string(),
    channel: z.string(),
    ts: z.string(),
    thread_ts: z.string().optional(),
    text: z.string().default(""),
    files: z.array(SlackFile).optional(),
    bot_id: z.string().optional(),
    subtype: z.string().optional(),
  }),
});

/** One in-flight job per device. No public listener, arbitrary destination, or offline queue. */
export class SlackRelay {
  private server: Server | null = null;
  private readonly approvals: SlackApprovals | null;
  private readonly online = new Map<string, number>();
  private readonly jobs = new Map<
    string,
    {
      job: SlackJob;
      waiting: boolean;
      finishing?: Promise<void>;
      loading?: Promise<void>;
      loaded?: boolean;
      progressTs?: string;
      progressText?: string;
      progressAt?: number;
      progressing?: Promise<void>;
    }
  >();
  private readonly completed: Record<string, string>;
  private readonly conversations = new Map<string, Conversation>();
  private readonly queued = new Map<string, SlackJob[]>();
  constructor(
    private readonly options: {
      workspaceId: string;
      botId: string;
      ownerUserId?: string;
      devices(): Device[];
      /** Persist before acknowledging Slack; an interrupted job is never automatically re-executed. */
      admit(eventId: string): boolean;
      post(job: SlackJob, text: string): Promise<void>;
      progress?(job: SlackJob, text: string, ts?: string): Promise<string>;
      image?(id: string): Promise<SlackImageData>;
      history?(job: SlackJob): Promise<z.infer<typeof ContextMessage>[]>;
      postApproval?(job: SlackJob, request: ApprovalPage): Promise<string>;
      updateApproval?(job: SlackJob, ts: string, text: string): Promise<void>;
      journal?: { read(): RelayJournal; write(value: RelayJournal): void };
      now?: () => number;
    },
  ) {
    this.approvals = options.postApproval && options.updateApproval ? new SlackApprovals(options.postApproval, options.updateApproval) : null;
    const saved = options.journal?.read();
    this.completed = saved?.completed ?? {};
    for (const conversation of saved?.conversations ?? []) this.conversations.set(JSON.stringify([conversation.channelId, conversation.threadTs]), conversation);
    for (const { deviceId, job } of saved?.queued ?? []) {
      if (job.workspaceId !== options.workspaceId || !options.devices().some((d) => d.id === deviceId && d.userId === job.userId)) continue;
      this.queued.set(deviceId, [...(this.queued.get(deviceId) ?? []), job]);
    }
    for (const { deviceId, job, progressTs } of saved?.jobs ?? []) {
      if (job.workspaceId === options.workspaceId && options.devices().some((d) => d.id === deviceId && d.userId === job.userId)) this.jobs.set(deviceId, { job, waiting: false, progressTs });
    }
  }
  action(raw: unknown): boolean {
    return this.approvals?.act(raw) ?? false;
  }

  private persist(): void {
    this.options.journal?.write({
      jobs: [...this.jobs].map(([deviceId, { job, progressTs }]) => ({ deviceId, job, progressTs })),
      completed: this.completed,
      conversations: [...this.conversations.values()],
      queued: [...this.queued].flatMap(([deviceId, jobs]) => jobs.map((job) => ({ deviceId, job }))),
    });
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }
  isOnline(id: string): boolean {
    return this.now() - (this.online.get(id) ?? 0) < 10_000;
  }
  remove(id: string): void {
    const job = this.jobs.get(id)?.job;
    if (job) this.approvals?.revoke(job.id);
    this.online.delete(id);
    this.jobs.delete(id);
    this.queued.delete(id);
    for (const conversation of this.conversations.values()) conversation.deviceIds = conversation.deviceIds.filter((deviceId) => deviceId !== id);
    delete this.completed[id];
    this.persist();
  }

  async receive(raw: unknown): Promise<void> {
    const parsed = Mention.safeParse(raw);
    if (!parsed.success) return;
    const { event, event_id, team_id } = parsed.data;
    if (team_id !== this.options.workspaceId || !/^[CG][A-Z0-9]+$/.test(event.channel) || event.bot_id || (event.subtype && event.subtype !== "file_share") || event.user === this.options.botId)
      return;
    const mentioned = event.text.includes(`<@${this.options.botId}>`);
    if (mentioned && this.options.ownerUserId && event.user !== this.options.ownerUserId) return;
    // Slack sends tagged messages through both subscriptions. Only app_mention owns those.
    if (event.type === "message" && mentioned) return;
    if (event.type === "app_mention" && !mentioned) return;
    const key = JSON.stringify([event.channel, event.thread_ts ?? event.ts]);
    let conversation = this.conversations.get(key);
    if (!mentioned && (!event.thread_ts || !conversation)) return;
    if (!this.options.admit(event_id)) return;
    const device = this.options.devices().find((d) => d.userId === event.user);
    if (!conversation) {
      conversation = { channelId: event.channel, threadTs: event.thread_ts ?? event.ts, deviceIds: [], messages: [] };
      this.conversations.set(key, conversation);
    }
    const context = [...conversation.messages];
    conversation.messages.push({
      id: `${event.channel}:${event.ts}`,
      userId: event.user,
      text: event.text.replaceAll(`<@${this.options.botId}>`, "").trim(),
      at: Number(event.ts) * 1000,
      files: event.files,
    });
    this.normalizeContext(conversation);
    this.persist();
    if (!mentioned && (!device || !conversation.deviceIds.includes(device.id))) return;
    const job: SlackJob = {
      id: event_id,
      workspaceId: team_id,
      userId: event.user,
      channelId: event.channel,
      threadTs: event.thread_ts ?? event.ts,
      messageTs: event.ts,
      text: event.text.replaceAll(`<@${this.options.botId}>`, "").trim(),
      context,
      files: event.files,
    };
    if (!device || !this.isOnline(device.id)) {
      await this.options.post(job, "Your OpenOrc desktop is not connected. Connect it in Settings → Slack, then mention me again.");
      return;
    }
    if ((!job.text && !job.files?.length) || job.text.length > 20_000) {
      await this.options.post(job, "Include a request of up to 20,000 characters after the mention.");
      return;
    }
    if (this.jobs.has(device.id)) {
      const active = this.jobs.get(device.id)!.job;
      const queue = this.queued.get(device.id) ?? [];
      if (active.channelId === job.channelId && active.threadTs === job.threadTs && event.thread_ts && queue.length < 20) {
        this.queued.set(device.id, [...queue, job]);
        this.persist();
        return;
      }
      await this.options.post(job, "Your desktop already has a Slack request in progress. Wait for its reply before sending another.");
      return;
    }
    // Reserve before awaiting the API so two simultaneous mentions cannot overwrite each other.
    this.jobs.set(device.id, { job, waiting: false });
    if (!conversation.deviceIds.includes(device.id)) conversation.deviceIds.push(device.id);
    this.persist();
    try {
      if (mentioned) await this.options.post(job, "Request received for your OpenOrc desktop.");
    } catch {
      /* The job still runs if Slack's acceptance message fails. */
    }
  }

  private normalizeContext(conversation: Conversation): void {
    // Keep the opener and all replies; deduplicate deliveries instead of dropping older context.
    conversation.messages = [...new Map(conversation.messages.map((m) => [m.id, m])).values()].sort((a, b) => a.at - b.at);
  }

  async listen(port: number): Promise<number> {
    const server = createServer((req, res) => {
      void this.route(req)
        .then((body) => {
          res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          res.end(JSON.stringify(body));
        })
        .catch((error: unknown) => {
          const failure = error instanceof RelayRequestError ? error : new RelayRequestError(error instanceof z.ZodError || error instanceof SyntaxError ? "invalid_request" : "rejected");
          res.writeHead(failureStatus[failure.code], {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify({ code: failure.code, slackCode: failure.slackCode }));
        });
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Relay did not bind a port.");
    return address.port;
  }

  private async route(req: IncomingMessage): Promise<unknown> {
    // Browsers cannot use the relay as a cross-origin credential endpoint.
    if (req.headers.origin || req.method !== "POST") throw new Error("Rejected");
    const key = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
    if (key.length > 200) throw new Error("Rejected");
    const digest = Buffer.from(hashKey(key), "hex");
    const device = this.options.devices().find((d) => {
      const expected = Buffer.from(d.keyHash, "hex");
      return expected.length === digest.length && timingSafeEqual(expected, digest);
    });
    if (!device) throw new Error("Rejected");
    let body = "";
    for await (const chunk of req) {
      body += String(chunk);
      if (Buffer.byteLength(body) > 256_000) throw new Error("Rejected");
    }
    return this.request(device.id, req.url ?? "", JSON.parse(body));
  }

  /** Internal transport for a personal desktop; never exposed as an unauthenticated RPC. */
  async request(deviceId: string, route: string, input: unknown): Promise<unknown> {
    const device = this.options.devices().find((d) => d.id === deviceId);
    if (!device) throw new RelayRequestError("rejected");
    if (route === "/poll") return this.pollDevice(device, input);
    if (route === "/image") return this.readImage(device, input);
    if (route === "/approvals") return this.syncApprovals(device, input);
    if (route === "/result") return this.deliverResult(device, input);
    throw new Error("Rejected");
  }

  private async pollDevice(device: Device, input: unknown): Promise<unknown> {
    z.object({}).strict().parse(input);
    this.online.set(device.id, this.now());
    const current = this.jobs.get(device.id);
    if (current && !current.loaded && this.options.history) {
      current.loading ??= this.options
        .history(current.job)
        .then((messages) => {
          const context = new Map((current.job.context ?? []).filter((m) => !messages.length || m.userId !== "openorc").map((m) => [m.id, m]));
          for (const m of messages) context.set(m.id, m);
          current.job.context = [...context.values()].filter((m) => m.id !== `${current.job.channelId}:${current.job.messageTs}`).sort((a, b) => a.at - b.at);
          delete current.job.contextWarning;
        })
        .catch(() => {
          current.job.contextWarning = "Slack could not load the full thread history. Earlier messages may be missing; check history scopes, channel access and Slack rate limits.";
        })
        .finally(() => {
          current.loaded = true;
          this.persist();
        });
      await current.loading;
    }
    return { userId: device.userId, workspaceId: this.options.workspaceId, job: current && this.jobs.get(device.id) === current ? current.job : null };
  }

  private async readImage(device: Device, input: unknown): Promise<unknown> {
    const inputFile = z.object({ jobId: z.string(), fileId: z.string() }).strict().parse(input);
    const job = this.jobs.get(device.id)?.job;
    if (!job || job.id !== inputFile.jobId || job.userId !== device.userId) throw new RelayRequestError("job_mismatch");
    const files = [...(job.files ?? []), ...(job.context ?? []).flatMap((m) => m.files ?? [])];
    if (!files.some((f) => f.id === inputFile.fileId)) throw new RelayRequestError("rejected");
    return this.options.image ? this.options.image(inputFile.fileId) : { error: "Update the relay host to support Slack images." };
  }

  private async syncApprovals(device: Device, input: unknown): Promise<unknown> {
    const sync = ApprovalSync.parse(input);
    const job = this.jobs.get(device.id)?.job;
    if (!job || job.id !== sync.jobId || job.userId !== device.userId) throw new RelayRequestError("job_mismatch");
    try {
      return { decisions: this.approvals ? await this.approvals.sync(job, sync.requests) : [] };
    } catch (error) {
      throw deliveryFailure(error);
    }
  }

  /** One result owner shares in-flight sends and retains uncertain delivery for retry. */
  private async deliverResult(device: Device, input: unknown): Promise<unknown> {
    const result = SlackResult.parse(input);
    if (this.completed[device.id] === result.id) return { ok: true };
    const current = this.jobs.get(device.id);
    // A repeat after successful delivery is harmless, but cannot post anything new.
    if (!current) {
      if (this.completed[device.id] !== result.id) throw new RelayRequestError("job_mismatch");
      return { ok: true };
    }
    if (current.job.id !== result.id) throw new RelayRequestError("job_mismatch");
    if (result.kind === "progress") {
      if (current.finishing || !this.options.progress || current.progressText === result.text || (current.progressAt !== undefined && this.now() - current.progressAt < 2000)) return { ok: true };
      current.progressing ??= this.options.progress(current.job, result.text, current.progressTs).then((ts) => {
        current.progressTs = ts;
        current.progressText = result.text;
        current.progressAt = this.now();
        this.persist();
      });
      try {
        await current.progressing;
      } catch (error) {
        throw deliveryFailure(error);
      } finally {
        current.progressing = undefined;
      }
    } else if (result.kind === "waiting") {
      if (!current.waiting) {
        current.waiting = true;
        try {
          await this.options.post(current.job, "Waiting for you. Use the permission request buttons in this thread; questions that need a written answer are available on your desktop.");
        } catch (error) {
          current.waiting = false;
          throw deliveryFailure(error);
        }
      }
    } else {
      // Concurrent/retried HTTP requests share one Slack send operation.
      current.finishing ??= (async () => {
        await current.progressing?.catch(() => {});
        await this.approvals?.sync(current.job, []);
        if (current.progressTs && this.options.progress) {
          try {
            await this.options.progress(current.job, result.text, current.progressTs);
          } catch (error) {
            const failure = deliveryFailure(error);
            // Only a definitive edit rejection permits a new final message. Timeouts
            // may have succeeded remotely, so retry those against the same message.
            if (!["message_not_found", "block_mismatch", "edit_window_closed", "cant_update_message"].includes(failure.slackCode ?? "")) throw error;
            await this.options.post(current.job, result.text);
          }
        } else await this.options.post(current.job, result.text);
      })().then(() => {
        this.jobs.delete(device.id);
        this.completed[device.id] = result.id;
        const conversation = this.conversations.get(JSON.stringify([current.job.channelId, current.job.threadTs]));
        if (conversation) {
          conversation.messages.push({ id: `${result.id}:reply`, userId: "openorc", text: result.text, at: Date.now() });
          this.normalizeContext(conversation);
        }
        const next = this.queued.get(device.id)?.shift();
        if (next) {
          const nextContext: Conversation = {
            channelId: next.channelId,
            threadTs: next.threadTs,
            deviceIds: [],
            messages: [...(next.context ?? []), { id: `${result.id}:reply`, userId: "openorc", text: result.text, at: Date.now() }],
          };
          this.normalizeContext(nextContext);
          this.jobs.set(device.id, { job: { ...next, context: nextContext.messages }, waiting: false });
        }
        this.persist();
      });
      try {
        await current.finishing;
      } catch (error) {
        current.finishing = undefined;
        throw deliveryFailure(error);
      }
    }
    return { ok: true };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.online.clear();
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}

/** Remote machines use SSH forwarding. Credentials never travel over plain LAN HTTP. */
export function relayUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Use http://127.0.0.1:PORT. For another machine, open an SSH tunnel first.");
  }
  return url.origin;
}

export async function relayRequest(url: string, key: string, route: "poll" | "result" | "approvals" | "image", body: unknown): Promise<unknown> {
  const response = await fetch(`${relayUrl(url)}/${route}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(route === "image" ? 30_000 : 8000),
  });
  if (!response.ok) {
    const failure = RelayFailure.safeParse(await response.json().catch(() => null));
    if (failure.success) throw new RelayRequestError(failure.data.code, failure.data.slackCode);
    throw new Error(`Relay request failed (HTTP ${response.status}). Check the relay host.`);
  }
  return response.json();
}
