interface DiagramNode {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  sub?: string;
  emphasis?: boolean;
  compact?: boolean;
}

interface DiagramGroup {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
}

interface DiagramEdge {
  path: string;
  both?: boolean;
  dashed?: boolean;
}

interface DiagramLabel {
  x: number;
  y: number;
  text: string;
  width: number;
}

interface Drawing {
  width: number;
  height: number;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups?: DiagramGroup[];
  labels?: DiagramLabel[];
}

export interface DiagramSpec {
  id: string;
  title: string;
  description: string;
  caption: string;
  wide: Drawing;
  narrow: Drawing;
}

export const systemDiagram: DiagramSpec = {
  id: "system",
  title: "The parts of OpenOrc",
  description:
    "On your computer, the interface talks to the core, and the core talks to the agent command-line tools. The core writes to the SQLite database and runs Git in your repository. Agents edit files in the repository directly and call their model providers over the internet.",
  caption: "Everything inside the dashed line runs on your computer. Agent CLIs reach their model providers with your own logins; OpenOrc has no server of its own.",
  wide: {
    width: 760,
    height: 404,
    groups: [{ x: 0, y: 0, w: 760, h: 300, label: "Your computer" }],
    nodes: [
      { x: 24, y: 56, w: 200, h: 72, label: "Interface", sub: "React, one per window" },
      { x: 280, y: 56, w: 200, h: 72, label: "Core", sub: "Records, runs, tools", emphasis: true },
      { x: 536, y: 56, w: 200, h: 72, label: "Agent CLIs", sub: "Claude Code, Codex, OpenCode" },
      { x: 176, y: 204, w: 200, h: 72, label: "SQLite database", sub: "Conversations and events" },
      { x: 408, y: 204, w: 200, h: 72, label: "Your repository", sub: "Checkout and worktrees" },
      { x: 536, y: 324, w: 200, h: 72, label: "Model providers", sub: "Through your accounts" },
    ],
    edges: [
      { path: "M230 92 H274", both: true },
      { path: "M486 92 H530", both: true },
      { path: "M340 128 V156 Q340 164 332 164 H284 Q276 164 276 172 V198" },
      { path: "M420 128 V156 Q420 164 428 164 H500 Q508 164 508 172 V198" },
      { path: "M624 128 V232 Q624 240 616 240 H614" },
      { path: "M696 134 V318", both: true },
    ],
  },
  narrow: {
    width: 320,
    height: 452,
    groups: [{ x: 0, y: 0, w: 320, h: 332, label: "Your computer" }],
    nodes: [
      { x: 88, y: 40, w: 144, h: 60, label: "Interface", compact: true },
      { x: 8, y: 140, w: 144, h: 60, label: "Core", emphasis: true, compact: true },
      { x: 168, y: 140, w: 144, h: 60, label: "Database", compact: true },
      { x: 8, y: 248, w: 144, h: 60, label: "Agent CLIs", compact: true },
      { x: 168, y: 248, w: 144, h: 60, label: "Repository", compact: true },
      { x: 8, y: 380, w: 144, h: 60, label: "Providers", compact: true },
    ],
    edges: [
      { path: "M160 106 V112 Q160 120 152 120 H88 Q80 120 80 128 V134", both: true },
      { path: "M152 170 H162" },
      { path: "M80 206 V242", both: true },
      { path: "M152 278 H162" },
      { path: "M80 314 V374", both: true },
    ],
  },
};

export const turnDiagram: DiagramSpec = {
  id: "turn",
  title: "One message, from the composer to the transcript",
  description:
    "The composer sends a request to the core. The core starts or reuses the agent CLI, which calls its provider. The CLI's output goes through an adapter that translates it into shared events. The events feed the live transcript and the SQLite ledger.",
  caption:
    "The live transcript and the ledger receive the same events, except native provider output, which goes to a log file. The ledger clears streaming fragments once the finished item is stored. Frames go to the interface at most every 16 ms per run; the ledger writes in batches every 50 ms.",
  wide: {
    width: 760,
    height: 392,
    nodes: [
      { x: 20, y: 16, w: 160, h: 72, label: "Composer", sub: "runs.start / runs.send" },
      { x: 220, y: 16, w: 160, h: 72, label: "Core services", sub: "Validate and resolve", emphasis: true },
      { x: 420, y: 16, w: 160, h: 72, label: "Agent CLI", sub: "Your login" },
      { x: 620, y: 16, w: 120, h: 72, label: "Provider", compact: true },
      { x: 420, y: 160, w: 160, h: 72, label: "Adapter", sub: "Shared events" },
      { x: 120, y: 304, w: 200, h: 72, label: "Live transcript", sub: "Frames to the window" },
      { x: 440, y: 304, w: 200, h: 72, label: "SQLite ledger", sub: "Events, in order" },
    ],
    edges: [
      { path: "M180 52 H214" },
      { path: "M380 52 H414" },
      { path: "M586 52 H614", both: true },
      { path: "M500 88 V154" },
      { path: "M460 232 V264 Q460 272 452 272 H228 Q220 272 220 280 V298" },
      { path: "M540 232 V298" },
    ],
  },
  narrow: {
    width: 320,
    height: 484,
    nodes: [
      { x: 40, y: 12, w: 240, h: 64, label: "Composer", sub: "runs.start / runs.send" },
      { x: 40, y: 104, w: 240, h: 64, label: "Core services", sub: "Validate and resolve", emphasis: true },
      { x: 40, y: 196, w: 240, h: 64, label: "Agent CLI", sub: "Calls your provider" },
      { x: 40, y: 288, w: 240, h: 64, label: "Adapter", sub: "Shared events" },
      { x: 8, y: 408, w: 144, h: 64, label: "Transcript", compact: true },
      { x: 168, y: 408, w: 144, h: 64, label: "Ledger", compact: true },
    ],
    edges: [
      { path: "M160 76 V98" },
      { path: "M160 168 V190" },
      { path: "M160 260 V282" },
      { path: "M120 352 V372 Q120 380 112 380 H88 Q80 380 80 388 V402" },
      { path: "M200 352 V372 Q200 380 208 380 H232 Q240 380 240 388 V402" },
    ],
  },
};

export const memoryDiagram: DiagramSpec = {
  id: "memory",
  title: "How a finished run becomes context for later work",
  description:
    "When an agent process exits, an extraction job distills the run into a summary and up to six memories. They are stored in the project's memory. A brief and a search tool bring selected memories into later runs, whose finished work can feed the cycle again.",
  caption: "Extraction runs after an agent process exits, not after every message. The dashed line is the next finished run; memory never starts work on its own.",
  wide: {
    width: 760,
    height: 344,
    nodes: [
      { x: 20, y: 16, w: 200, h: 88, label: "Finished run", sub: "Agent process exits" },
      { x: 280, y: 16, w: 200, h: 88, label: "Extraction", sub: "One-shot agent CLI" },
      { x: 540, y: 16, w: 200, h: 88, label: "Project memory", sub: "SQLite, per project", emphasis: true },
      { x: 540, y: 236, w: 200, h: 88, label: "Brief and search", sub: "Ranked selection" },
      { x: 280, y: 236, w: 200, h: 88, label: "Later run", sub: "Instructions and tools" },
    ],
    edges: [{ path: "M220 60 H274" }, { path: "M480 60 H534" }, { path: "M640 104 V230" }, { path: "M540 280 H486" }, { path: "M280 280 H128 Q120 280 120 272 V110", dashed: true }],
    labels: [{ x: 204, y: 246, text: "When it finishes", width: 136 }],
  },
  narrow: {
    width: 320,
    height: 556,
    nodes: [
      { x: 60, y: 12, w: 248, h: 72, label: "Finished run", sub: "Agent process exits" },
      { x: 60, y: 128, w: 248, h: 72, label: "Extraction", sub: "One-shot agent CLI" },
      { x: 60, y: 244, w: 248, h: 72, label: "Project memory", sub: "SQLite, per project", emphasis: true },
      { x: 60, y: 360, w: 248, h: 72, label: "Brief and search", sub: "Ranked selection" },
      { x: 60, y: 476, w: 248, h: 72, label: "Later run", sub: "Instructions and tools" },
    ],
    edges: [{ path: "M184 84 V122" }, { path: "M184 200 V238" }, { path: "M184 316 V354" }, { path: "M184 432 V470" }, { path: "M60 512 H28 Q20 512 20 504 V56 Q20 48 28 48 H54", dashed: true }],
  },
};

export const teamDiagram: DiagramSpec = {
  id: "team",
  title: "How a team execution routes work",
  description:
    "The lead delegates through OpenOrc's coordinator, which admits turns within the team's limits and routes messages. Participants share the lead's folder; each assignment gets its own worktree, and its changes are merged back when it finishes.",
  caption: "The coordinator decides who runs next and delivers every message. Agents never start each other directly; they call OpenOrc's team tools.",
  wide: {
    width: 760,
    height: 400,
    nodes: [
      { x: 280, y: 12, w: 200, h: 80, label: "Lead", sub: "Plans and delegates" },
      { x: 220, y: 152, w: 320, h: 80, label: "Coordinator", sub: "Admits turns, routes messages", emphasis: true },
      { x: 20, y: 308, w: 200, h: 80, label: "Participant", sub: "Shares the lead's folder" },
      { x: 280, y: 308, w: 200, h: 80, label: "Assignment", sub: "Own worktree" },
      { x: 540, y: 308, w: 200, h: 80, label: "Assignment", sub: "Own worktree" },
    ],
    edges: [
      { path: "M380 98 V146", both: true },
      { path: "M280 238 V264 Q280 272 272 272 H128 Q120 272 120 280 V302", both: true },
      { path: "M380 238 V302", both: true },
      { path: "M480 238 V264 Q480 272 488 272 H632 Q640 272 640 280 V302", both: true },
    ],
  },
  narrow: {
    width: 320,
    height: 360,
    nodes: [
      { x: 60, y: 12, w: 200, h: 72, label: "Lead", sub: "Plans and delegates" },
      { x: 28, y: 148, w: 264, h: 80, label: "Coordinator", sub: "Admits turns, routes messages", emphasis: true },
      { x: 8, y: 300, w: 96, h: 48, label: "Participant", compact: true },
      { x: 112, y: 300, w: 96, h: 48, label: "Assignment", compact: true },
      { x: 216, y: 300, w: 96, h: 48, label: "Assignment", compact: true },
    ],
    edges: [
      { path: "M160 90 V142", both: true },
      { path: "M96 234 V256 Q96 264 88 264 H64 Q56 264 56 272 V294", both: true },
      { path: "M160 234 V294", both: true },
      { path: "M224 234 V256 Q224 264 232 264 H256 Q264 264 264 272 V294", both: true },
    ],
  },
};
