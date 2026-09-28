import { spawn } from "node:child_process";
import type { AgentSkill } from "@openorc/protocol";
import { agentBinary } from "../bin.js";
import { stopProcess, waitForProcessGroup } from "../process-lifetime.js";

interface OpenCodeSkill {
  id?: unknown;
  description?: unknown;
  path?: unknown;
}

interface OpenCodeSkillsResponse {
  data?: OpenCodeSkill[];
}

function skillSource(file: string, sources: ReadonlyMap<string, AgentSkill["source"]>, home: string): AgentSkill["source"] {
  const discovered = sources.get(file);
  if (discovered) return discovered;
  if (file.startsWith("/builtin/")) return "system";
  if (file.includes("/plugins/")) return "plugin";
  if (file.startsWith(`${home}/.`)) return "user";
  return "project";
}

/** The API has applied OpenCode's source precedence and includes its built-in skills. */
export function openCodeSkillRows(rows: OpenCodeSkill[], sources: ReadonlyMap<string, AgentSkill["source"]>, home: string): AgentSkill[] {
  return rows
    .filter((skill) => typeof skill.id === "string" && typeof skill.path === "string")
    .map((skill) => {
      const file = skill.path as string;
      return {
        name: skill.id as string,
        description: typeof skill.description === "string" ? skill.description.replace(/\s+/g, " ").trim() : "",
        path: file,
        source: skillSource(file, sources, home),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** A private, short-lived server keeps discovery scoped to this project and needs no stored credentials. */
export async function listNativeOpenCodeSkills(projectRoot: string): Promise<OpenCodeSkill[] | null> {
  const proc = spawn(agentBinary("opencode"), ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const closed = new Promise<void>((resolve) => proc.once("close", () => resolve()));
  proc.stderr.resume();
  let header = "";
  let timer: NodeJS.Timeout | undefined;
  try {
    const connection = await Promise.race([
      new Promise<{ base: string; password: string }>((resolve, reject) => {
        proc.once("error", reject);
        proc.once("close", () => reject(new Error("OpenCode service exited")));
        proc.stdout.on("data", (chunk: Buffer) => {
          header += chunk.toString();
          if (header.length > 4096) return reject(new Error("OpenCode service header was too large"));
          const base = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(header)?.[1];
          const password = /server password ([^\s]+)/.exec(header)?.[1];
          if (base && password) resolve({ base, password });
        });
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("OpenCode service did not start")), 5000);
      }),
    ]);
    const authorization = `Basic ${Buffer.from(`opencode:${connection.password}`).toString("base64")}`;
    const url = `${connection.base}/api/skill?${new URLSearchParams({ "location[directory]": projectRoot })}`;
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, { headers: { Authorization: authorization }, signal: AbortSignal.timeout(2000) });
        if (!response.ok) return null;
        const catalog = (await response.json()) as OpenCodeSkillsResponse;
        if (Array.isArray(catalog.data) && catalog.data.length) return catalog.data;
      } catch {
        // The service accepts connections before its skill registry is ready.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    stopProcess(proc);
    await closed;
    await waitForProcessGroup(proc);
  }
}
