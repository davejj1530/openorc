import { z } from "zod";
import type { AgentSkill } from "@openorc/protocol";
import type { AgentLaunchEnvironment } from "../launch-environment.js";
import { PiRpc } from "./rpc.js";

const commands = z.object({
  commands: z.array(
    z.object({ name: z.string(), description: z.string().optional(), source: z.string(), sourceInfo: z.object({ path: z.string(), scope: z.string(), origin: z.string().optional() }) }),
  ),
});

export async function listPiSkills(cwd: string, launch: Pick<AgentLaunchEnvironment, "binary" | "env">): Promise<AgentSkill[]> {
  const rpc = new PiRpc({ ...launch, revision: 0 }, cwd, ["--mode", "rpc", "--no-session", "--offline", "--approve", "--no-extensions", "--no-mcp"]);
  try {
    return commands
      .parse(await rpc.request("get_commands"))
      .commands.filter((command) => command.source === "skill")
      .map((command) => {
        let source: AgentSkill["source"] = command.sourceInfo.scope === "project" ? "project" : "user";
        if (command.sourceInfo.origin === "package") source = "plugin";
        return { name: command.name.replace(/^skill:/, ""), description: command.description ?? "", path: command.sourceInfo.path, source };
      });
  } finally {
    rpc.close();
    await rpc.done;
  }
}
