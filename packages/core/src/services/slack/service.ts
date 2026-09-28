import { SocketModeClient } from "@slack/socket-mode";
import { WebClient, LogLevel } from "@slack/web-api";
import { settings, redactJson } from "@openorc/db";
import type { AgentEvent, RpcParams, SlackClientConfig, SlackDirectConfig, SlackStatus } from "@openorc/protocol";
import { z } from "zod";
import type { OpenOrc } from "../../openorc.js";
import { ContextMessage, SlackJob, SlackRelay, RelayRequestError, newDevice, relayRequest, relayUrl, type Device, type SlackResult, type RelayJournal } from "./relay.js";
import { RemoteDecision, approvalSections } from "./approvals.js";
import { downloadSlackImage, SlackFile, SlackImages } from "./images.js";
import type { AttachmentService } from "../attachments.js";
import { SlackRunner } from "./runner.js";
import type { ExecutionSwitchInput } from "@openorc/mcp";
import type { TurnSettledOutcome } from "../runs.js";

export interface SlackSecretStore {
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
}
interface Saved {
  mode?: "direct" | "relay";
  direct?: SlackDirectConfig & { botToken: string; appToken: string; workspaceId?: string; workspace?: string; ownerName?: string; botId?: string };
  host?: { botToken: string; appToken: string; channelId: string; port: number; workspaceId?: string };
  devices: Device[];
  client?: SlackClientConfig & { deviceKey: string };
}
const Poll = z.object({ userId: z.string(), workspaceId: z.string(), job: SlackJob.nullable() });

export class SlackService {
  private saved: Saved = { devices: [] };
  private loaded = false;
  private directSession = false;
  private directError: string | null = null;
  private relay: SlackRelay | null = null;
  private socket: SocketModeClient | null = null;
  private hostConnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private workspace: string | null = null;
  private hostError: string | null = null;
  private clientError: string | null = null;
  private clientConnected = false;
  private clientUser: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<void> | null = null;
  private active: string | null = null;
  private outbox: SlackResult | null = null;
  private waiting: SlackResult | null = null;
  private generation = 0;
  private readonly runner: SlackRunner;
  private mutation: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly core: Pick<OpenOrc, "db" | "threads" | "projects" | "settings" | "runs" | "system">,
    private readonly secrets: SlackSecretStore | undefined,
    attachments: AttachmentService,
  ) {
    this.runner = new SlackRunner(core, new SlackImages(core.db, attachments));
  }
  observe(event: AgentEvent) {
    this.runner.observe(event);
  }
  settled(runId: string, outcome: TurnSettledOutcome) {
    this.runner.settled(runId, outcome);
  }
  executionContext(runId: string) {
    return this.runner.executionContext(runId);
  }
  executionAvailable(runId: string) {
    return this.runner.executionAvailable(runId);
  }
  switchExecution(runId: string, input: ExecutionSwitchInput) {
    return this.runner.switchExecution(runId, input);
  }

  /** Serialize settings/connect mutations, including the encrypted read-modify-write. */
  change<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(fn, fn);
    this.mutation = next.catch(() => {});
    return next;
  }
  private async load(): Promise<void> {
    if (this.loaded) return;
    if (!this.secrets) throw new Error("Slack requires the desktop's protected credential storage.");
    const raw = await this.secrets.load();
    if (raw) this.saved = JSON.parse(raw) as Saved;
    this.loaded = true;
  }
  private async save(next: Saved): Promise<void> {
    if (!this.secrets) throw new Error("Protected credential storage is unavailable.");
    await this.secrets.save(JSON.stringify(next));
    this.saved = next;
  }
  async status(): Promise<SlackStatus> {
    await this.load();
    const host = this.saved.host;
    const client = this.saved.client;
    const direct = this.saved.direct;
    return {
      mode: this.saved.mode ?? (host || client ? "relay" : "direct"),
      direct: {
        configured: Boolean(direct),
        enabled: this.directSession && Boolean(this.socket || this.timer),
        connected: this.directSession && this.hostConnected && this.clientConnected,
        busy: this.directSession && Boolean(this.active),
        error: this.directError ?? (this.directSession ? (this.clientError ?? this.hostError) : null),
        config: direct ? { userId: direct.userId, mode: direct.mode, agent: direct.agent, model: direct.model, permissionMode: direct.permissionMode } : null,
        workspace: direct?.workspace ?? null,
        ownerName: direct?.ownerName ?? null,
        botId: direct?.botId ?? null,
      },
      host: {
        configured: Boolean(host),
        enabled: !this.directSession && Boolean(this.socket),
        connected: !this.directSession && this.hostConnected,
        channelId: host?.channelId ?? "",
        port: host?.port ?? 47831,
        workspace: this.workspace,
        error: this.directSession ? null : this.hostError,
      },
      devices: this.saved.devices.map(({ id, userId, label }) => ({ id, userId, label, online: this.relay?.isOnline(id) ?? false })),
      client: {
        configured: Boolean(client),
        enabled: !this.directSession && Boolean(this.timer),
        connected: !this.directSession && this.clientConnected,
        userId: this.clientUser,
        busy: !this.directSession && Boolean(this.active),
        error: this.directSession ? null : this.clientError,
        config: client ? { relayUrl: client.relayUrl, projectId: client.projectId, mode: client.mode, agent: client.agent, model: client.model, permissionMode: client.permissionMode } : null,
      },
    };
  }
  async saveDirect(input: SlackDirectConfig): Promise<void> {
    await this.load();
    if (this.socket || this.timer || this.active) throw new Error("Disconnect Slack and finish pending work before changing settings.");
    const botToken = input.botToken ?? this.saved.direct?.botToken;
    const appToken = input.appToken ?? this.saved.direct?.appToken;
    if (!botToken || !appToken) throw new Error("Enter the bot token and app token from your Slack app.");
    await this.save({ ...this.saved, mode: "direct", direct: { ...input, botToken, appToken } });
    this.directError = null;
  }
  async connectDirect(): Promise<void> {
    await this.load();
    if (!this.saved.direct) throw new Error("Save your personal Slack settings first.");
    if (!this.directSession && (this.socket || this.timer || this.active)) throw new Error("Disconnect the team relay and finish pending work first.");
    this.directSession = true;
    this.directError = null;
    await this.save({ ...this.saved, mode: "direct" });
    try {
      if (!this.socket) await this.startHost(true);
      await this.startClient();
      if (!this.hostConnected) throw new Error("Slack is still reconnecting. Wait for Connected before sending another request.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not connect to Slack.";
      this.directError = this.socket ? null : message;
      throw new Error(message);
    }
  }
  async disconnectDirect(): Promise<void> {
    if (!this.directSession) return;
    this.disconnectClient();
    await this.disconnectHost();
    this.directError = null;
    this.hostError = null;
    this.clientError = null;
  }
  async saveHost(input: RpcParams<"slack.host.save">): Promise<void> {
    await this.load();
    if (this.socket) throw new Error("Disconnect the relay before changing its settings.");
    const botToken = input.botToken ?? this.saved.host?.botToken;
    const appToken = input.appToken ?? this.saved.host?.appToken;
    if (!botToken || !appToken) throw new Error("Enter both Slack tokens.");
    await this.save({ ...this.saved, host: { ...this.saved.host, ...input, botToken, appToken } });
  }

  async connectHost(): Promise<void> {
    await this.load();
    if (this.directSession && (this.socket || this.timer || this.active)) throw new Error("Disconnect the personal connection and finish pending work first.");
    this.directSession = false;
    await this.save({ ...this.saved, mode: "relay" });
    await this.startHost(false);
  }
  private async startHost(personal: boolean): Promise<void> {
    await this.load();
    if (this.socket) throw new Error("The relay is already started. Disconnect it before reconnecting.");
    const host = personal ? this.saved.direct : this.saved.host;
    if (!host) throw new Error("Save your Slack tokens and channel first.");
    this.hostError = null;
    const web = new WebClient(host.botToken, { logLevel: LogLevel.ERROR, logger: quietLogger, retryConfig: { retries: 2 }, timeout: 10_000 });
    let relay: SlackRelay | null = null;
    let socket: SocketModeClient | null = null;
    try {
      const auth = await web.auth.test();
      if (!auth.team_id || !auth.user_id || !auth.bot_id) throw new Error("Not a bot installation");
      if (!personal && host.workspaceId && host.workspaceId !== auth.team_id && this.saved.devices.length) throw new Error("Remove registered devices before changing Slack workspace.");
      if (personal) {
        const direct = this.saved.direct!;
        const member = await web.users.info({ user: direct.userId }).catch(() => {
          throw new DirectSetupError("Could not check your Slack member ID. Add users:read, reinstall the Slack app, and confirm the ID.");
        });
        if (!member.user || member.user.id !== direct.userId || member.user.team_id !== auth.team_id || member.user.deleted || member.user.is_bot || member.user.is_app_user)
          throw new DirectSetupError("Choose your own active Slack member ID from the same workspace as the bot.");
        if (direct.workspaceId && direct.workspaceId !== auth.team_id && this.active) throw new DirectSetupError("Finish pending work before changing Slack workspace.");
        await this.save({
          ...this.saved,
          direct: {
            ...direct,
            workspaceId: auth.team_id,
            workspace: auth.team ?? auth.team_id,
            ownerName: member.user.profile?.display_name || member.user.real_name || member.user.name || direct.userId,
            botId: auth.user_id,
          },
        });
      } else await this.save({ ...this.saved, host: { ...this.saved.host!, workspaceId: auth.team_id } });
      const namespace = personal ? `slack.direct:${auth.team_id}:${auth.user_id}:${this.saved.direct!.userId}` : `slack.relay:${auth.team_id}`;
      const directDevice: Device = { id: "personal", userId: this.saved.direct?.userId ?? "", label: "This computer", keyHash: "" };
      this.workspace = auth.team ?? auth.team_id;
      relay = new SlackRelay({
        workspaceId: auth.team_id,
        botId: auth.user_id,
        ownerUserId: personal ? this.saved.direct!.userId : undefined,
        devices: () => (personal ? [directDevice] : this.saved.devices),
        journal: {
          read: () =>
            JSON.parse(
              settings.get(this.core.db, namespace) ?? (!personal ? settings.get(this.core.db, `slack.relay:${auth.team_id}:${this.saved.host!.channelId}`) : null) ?? '{"jobs":[],"completed":{}}',
            ) as RelayJournal,
          write: (value) => settings.set(this.core.db, namespace, redactJson(value)),
        },
        admit: (id) => {
          const key = personal ? `${namespace}:event:${id}` : `slack.event:${auth.team_id}:${id}`;
          if (settings.get(this.core.db, key)) return false;
          settings.set(this.core.db, key, "seen");
          return true;
        },
        image: (id) => downloadSlackImage(web, host.botToken, id),
        history: async (job) => {
          const messages: z.infer<typeof ContextMessage>[] = [];
          const cursors = new Set<string>();
          let cursor: string | undefined;
          do {
            const page = await web.conversations.replies({ channel: job.channelId, ts: job.threadTs, latest: job.messageTs, inclusive: true, limit: 200, ...(cursor ? { cursor } : {}) });
            if (!page.ok) throw new Error("Could not load Slack thread history");
            for (const message of page.messages ?? []) {
              if (!message.ts) continue;
              const files = message.files?.flatMap((file) => {
                const parsed = SlackFile.safeParse(file);
                return parsed.success ? [parsed.data] : [];
              });
              if (message.ts === job.messageTs) {
                job.files = [...new Map([...(job.files ?? []), ...(files ?? [])].map((file) => [file.id, file])).values()];
                continue;
              }
              messages.push({
                id: `${job.channelId}:${message.ts}`,
                userId: message.user === auth.user_id || message.bot_id === auth.bot_id ? "openorc" : (message.user ?? message.bot_id ?? "unknown"),
                text: (message.text ?? "").replaceAll(`<@${auth.user_id}>`, "").trim(),
                at: Number(message.ts) * 1000,
                files,
              });
            }
            cursor = page.response_metadata?.next_cursor?.trim() || undefined;
            if (page.has_more && !cursor) throw new Error("Slack thread history page was incomplete");
            if (cursor && cursors.has(cursor)) throw new Error("Slack repeated a history cursor");
            if (cursor) cursors.add(cursor);
          } while (cursor);
          return messages;
        },
        progress: async (job, text, ts) => {
          const content = {
            channel: job.channelId,
            text: replyFallback(job.userId, text),
            blocks: [
              { type: "section" as const, text: { type: "mrkdwn" as const, text: `<@${job.userId}>` } },
              { type: "markdown" as const, text: text.replace(/<(?=[@!])/g, "&lt;").slice(0, 12_000) },
            ],
          };
          if (ts) {
            await web.chat.update({ ...content, ts });
            return ts;
          }
          const posted = await web.chat.postMessage({ ...content, thread_ts: job.threadTs, unfurl_links: false, unfurl_media: false });
          if (!posted.ts) throw new Error("Slack did not return a progress message ID");
          return posted.ts;
        },
        postApproval: async (job, request) => {
          const result = await web.chat.postMessage({
            channel: job.channelId,
            thread_ts: job.threadTs,
            text: `<@${job.userId}> Permission requested.`,
            unfurl_links: false,
            unfurl_media: false,
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `<@${job.userId}> *Permission requested${request.parts > 1 ? ` · part ${request.part}/${request.parts}` : ""}*` } },
              ...approvalSections(request.text).map((text) => ({ type: "section" as const, text: { type: "plain_text" as const, text } })),
              ...(request.part === request.parts
                ? [
                    {
                      type: "context" as const,
                      elements: [
                        {
                          type: "plain_text" as const,
                          text: `Only you can decide. ${request.parts > 1 ? `Review all ${request.parts} parts above. ` : ""}Allow applies once. Buttons expire after 10 minutes.`,
                        },
                      ],
                    },
                    {
                      type: "actions" as const,
                      elements: [
                        ...(request.canAllow ? [{ type: "button" as const, action_id: "openorc_allow", text: { type: "plain_text" as const, text: "Allow once" }, value: request.id }] : []),
                        { type: "button" as const, action_id: "openorc_deny", text: { type: "plain_text" as const, text: "Deny" }, value: request.id },
                      ],
                    },
                  ]
                : []),
            ],
          });
          if (!result.ts) throw new Error("Slack did not return a message ID");
          return result.ts;
        },
        updateApproval: async (job, ts, text) => {
          await web.chat.update({ channel: job.channelId, ts, text: `<@${job.userId}> ${text}`, blocks: [] });
        },
        post: async (job, text) => {
          await web.chat.postMessage({
            channel: job.channelId,
            thread_ts: job.threadTs,
            text: replyFallback(job.userId, text),
            blocks: [
              { type: "section", text: { type: "mrkdwn", text: `<@${job.userId}>` } },
              { type: "markdown", text: text.replace(/<(?=[@!])/g, "&lt;").slice(0, 12_000) },
            ],
            unfurl_links: false,
            unfurl_media: false,
          });
        },
      });
      if (!personal) await relay.listen(this.saved.host!.port);
      // The SDK's own reconnect gives up without a word after a network error, so the service reconnects itself.
      socket = new SocketModeClient({
        appToken: host.appToken,
        logger: quietLogger,
        logLevel: LogLevel.ERROR,
        autoReconnectEnabled: false,
        clientOptions: { retryConfig: { retries: 0 }, timeout: 10_000 },
      });
      const target = relay;
      socket.on("app_mention", ({ body, ack }) => {
        // receive() records the event synchronously before its first network await.
        const received = target.receive(body);
        void ack().catch(() => {});
        void received.catch(() => {
          this.hostError = "Could not send a Slack reply. Check bot permissions and channel membership.";
        });
      });
      socket.on("message", ({ body, ack }) => {
        const received = target.receive(body);
        void ack().catch(() => {});
        void received.catch(() => {
          this.hostError = "Could not process a Slack thread reply.";
        });
      });
      socket.on("interactive", ({ body, ack }) => {
        // Socket Mode emits the envelope type (interactive), not payload.type (block_actions).
        void ack().catch(() => {});
        // The authenticated Socket Mode connection supplies identity; never trust a button's value for ownership.
        target.action(body);
      });
      this.trackConnection(socket);
      this.relay = relay;
      this.socket = socket;
      await socket.start();
      this.hostConnected = true;
    } catch (error) {
      this.socket = null;
      this.relay = null;
      this.hostConnected = false;
      await socket?.disconnect().catch(() => {});
      await relay?.close();
      this.hostError = connectionFailure(personal, error);
      throw new Error(this.hostError);
    }
  }
  /** Status follows the connection Slack reports, and a closed connection is reopened by the service. */
  private trackConnection(socket: SocketModeClient): void {
    socket.on("connected", () => {
      if (this.socket !== socket) return;
      this.hostConnected = true;
      this.hostError = null;
      this.reconnectAttempts = 0;
    });
    socket.on("disconnected", () => {
      if (this.socket !== socket) return;
      this.hostConnected = false;
      this.reconnect(socket);
    });
    socket.on("error", () => {
      if (this.socket === socket) this.hostError = "Slack connection interrupted. Reconnecting…";
    });
  }

  /**
   * Opens a new connection after the old one closed: at once the first time, since Slack closes connections it is
   * recycling, then with growing waits up to a minute. Status reads disconnected until Slack confirms the new one.
   */
  private reconnect(socket: SocketModeClient): void {
    if (this.reconnectTimer) return;
    this.hostError = "Slack connection lost. Reconnecting…";
    const wait = this.reconnectAttempts === 0 ? 0 : Math.min(60_000, 2_000 * 2 ** (this.reconnectAttempts - 1));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.socket !== socket) return;
      socket.start().catch(() => {
        if (this.socket === socket) this.reconnect(socket);
      });
    }, wait);
    this.reconnectTimer.unref?.();
  }

  async disconnectHost(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.hostConnected = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    await socket?.disconnect();
    await this.relay?.close();
    this.relay = null;
  }
  async addDevice(userId: string, label: string): Promise<{ id: string; deviceKey: string }> {
    await this.load();
    if (!this.saved.host?.workspaceId) throw new Error("Connect the relay to verify its workspace first.");
    if (this.saved.devices.some((d) => d.userId === userId)) throw new Error("This Slack user already has a device. Remove it before registering a replacement.");
    const { device, deviceKey } = newDevice(userId, label);
    await this.save({ ...this.saved, devices: [...this.saved.devices, device] });
    return { id: device.id, deviceKey };
  }
  async removeDevice(id: string): Promise<void> {
    await this.load();
    await this.save({ ...this.saved, devices: this.saved.devices.filter((d) => d.id !== id) });
    this.relay?.remove(id);
  }
  async saveClient(input: SlackClientConfig): Promise<void> {
    await this.load();
    if (this.timer || this.active) throw new Error("Finish the current Slack request and disconnect this desktop before changing its settings.");
    const deviceKey = input.deviceKey ?? this.saved.client?.deviceKey;
    if (!deviceKey) throw new Error("Enter the device key provided by your relay host.");
    if (input.projectId && !this.core.projects.get(input.projectId)) throw new Error("That project no longer exists. Choose another project or Automatic.");
    await this.save({ ...this.saved, client: { ...input, relayUrl: relayUrl(input.relayUrl), deviceKey } });
  }
  async connectClient(): Promise<void> {
    await this.load();
    if (this.directSession && (this.socket || this.timer || this.active)) throw new Error("Disconnect the personal connection and finish pending work first.");
    this.directSession = false;
    await this.save({ ...this.saved, mode: "relay" });
    await this.startClient();
  }
  private async startClient(): Promise<void> {
    if (!(this.directSession ? this.saved.direct : this.saved.client)) throw new Error("Save this desktop's settings first.");
    const wasEnabled = Boolean(this.timer);
    if (!this.timer) {
      this.generation++;
      this.timer = setInterval(() => void this.tick(), 1000);
    }
    // An explicit retry must await an actual attempt, even while automatic polling is enabled.
    await this.polling;
    await this.tick();
    if (this.clientError) {
      if (!wasEnabled && !this.clientConnected) this.disconnectClient();
      throw new Error(this.clientError);
    }
  }
  disconnectClient(): void {
    this.generation++;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.clientConnected = false;
  }
  private tick(): Promise<void> {
    if (this.polling) return this.polling;
    if (!this.timer || !(this.directSession ? this.saved.direct : this.saved.client)) return Promise.resolve();
    this.polling = this.poll().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }
  private async poll(): Promise<void> {
    const generation = this.generation;
    const config = this.directSession ? this.saved.direct! : this.saved.client!;
    const request = (route: "poll" | "result" | "approvals" | "image", body: unknown) => {
      if (!this.directSession) return relayRequest(this.saved.client!.relayUrl, this.saved.client!.deviceKey, route, body);
      if (this.relay) return this.relay.request("personal", `/${route}`, body);
      return Promise.reject(new Error("Slack is disconnected"));
    };
    try {
      let deliveryError: string | null = null;
      try {
        if (this.active && !this.outbox) {
          const sync = z.object({ decisions: z.array(RemoteDecision) }).parse(await request("approvals", { jobId: this.active, requests: this.runner.approvalSnapshot(this.active) }));
          if (generation !== this.generation) return;
          for (const decision of sync.decisions) this.runner.decide(this.active, decision);
        }
        if (this.active && !this.outbox) {
          const progress = this.runner.progressSnapshot(this.active);
          if (progress) {
            // Progress is best effort; its delivery must never prevent the final reply or approvals.
            await request("result", { id: this.active, kind: "progress", text: progress }).catch(() => {});
          }
        }
        const send = this.outbox ?? this.waiting;
        if (send) {
          await request("result", send);
          if (send === this.outbox) {
            this.outbox = null;
            this.active = null;
            this.waiting = null;
          }
          if (send === this.waiting) this.waiting = null;
        }
      } catch (error) {
        // Delivery and connection health are separate. Keep the outbox and heartbeat alive.
        deliveryError = error instanceof RelayRequestError ? this.requestError(error) : "Slack delivery did not finish. The reply is still pending and will be retried.";
      }
      const result = Poll.parse(await request("poll", {}));
      if (generation !== this.generation) return;
      this.clientConnected = true;
      this.clientError = deliveryError;
      this.clientUser = result.userId;
      const job = result.job;
      if (!job || this.active) return;
      if (job.userId !== result.userId || job.workspaceId !== result.workspaceId) throw new Error("Identity mismatch");
      this.active = job.id;
      void this.runner
        .execute(
          job,
          config,
          () => {
            this.waiting = { id: job.id, kind: "waiting", text: "" };
          },
          (fileId) => request("image", { jobId: job.id, fileId }),
        )
        .then((text) => {
          this.outbox = { id: job.id, kind: "finished", text };
        })
        .catch(() => {
          this.outbox = { id: job.id, kind: "finished", text: "OpenOrc could not accept the request. Check the local project and whether its thread is busy or archived." };
        });
    } catch (error) {
      if (generation !== this.generation) return;
      this.clientConnected = false;
      if (error instanceof RelayRequestError) this.clientError = this.requestError(error);
      else
        this.clientError = this.directSession
          ? "Slack did not respond. Check your connection and retry. Pending replies are retained."
          : "The relay did not respond. Check the relay host or SSH tunnel. Pending replies are retained.";
    }
  }
  private requestError(error: RelayRequestError): string {
    return this.directSession ? error.message.replace("The relay is reachable, but Slack delivery failed", "Slack delivery failed") : error.message;
  }
  async close(): Promise<void> {
    this.disconnectClient();
    this.runner.close();
    await this.disconnectHost();
  }
}

// Never let SDK diagnostic payloads put tokens or Slack messages into app logs.
const quietLogger = { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel: () => LogLevel.ERROR, setName() {} };
const escapeSlack = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// chat.update limits top-level text to 4,000 characters, independently of the
// 12,000-character Markdown body. Bound the escaped notification/accessibility
// preview without truncating the formatted answer or splitting escape entities.
function replyFallback(userId: string, text: string): string {
  const prefix = `<@${userId}> `;
  const suffix = "… (Full response in the message.)";
  const escaped = escapeSlack(text);
  // Leave room below the boundary and account for multibyte text. The live
  // failing reply also rejected a preview cut to exactly 4,000 JS characters.
  if (Buffer.byteLength(prefix + escaped, "utf8") < 3900) return prefix + escaped;
  const preview = text.slice(0, 600).replace(/[\uD800-\uDBFF]$/, "");
  return prefix + escapeSlack(preview) + suffix;
}

class DirectSetupError extends Error {}

function connectionFailure(personal: boolean, error: unknown): string {
  if (!personal) return "Could not connect. Check both tokens belong to the same Slack app, Socket Mode is enabled, and the local port is free.";
  if (error instanceof DirectSetupError) return error.message;
  return "Could not connect to Slack. Check both tokens belong to the same app, Socket Mode is enabled, and the app is installed in your workspace.";
}
