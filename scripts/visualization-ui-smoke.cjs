/** Production transcript + sandbox in Chromium, using a disposable profile and synthetic tool history. */
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const desktop = path.join(root, "apps/desktop");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function build() {
  const dir = await fs.mkdtemp("/tmp/openorc-visualization-smoke-");
  await require("./build-transcript-fixture.cjs")(dir, "visualization-ui.tsx");
  const { build: bundle } = require(require.resolve("esbuild", { paths: [path.dirname(require.resolve("tsx/package.json", { paths: [root] }))] }));
  await bundle({ entryPoints: [path.join(desktop, "src/main/mcp-app-sandbox.ts")], outfile: path.join(dir, "sandbox.cjs"), bundle: true, platform: "node", format: "cjs" });
  await fs.writeFile(
    path.join(dir, "preload.cjs"),
    `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('openorc',{mcpApps:{register:doc=>ipcRenderer.invoke('sandbox:register',doc),release:id=>ipcRenderer.send('sandbox:release',id)}});`,
  );
  if (process.argv.includes("--preview")) return preview(dir);
  const env = { ...process.env, OPENORC_VISUALIZATION_UI_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

async function check() {
  const { app, BrowserWindow, ipcMain, session } = require("electron");
  const dir = process.env.OPENORC_VISUALIZATION_UI_DIR;
  app.setPath("userData", path.join(dir, "profile"));
  await app.whenReady();
  const { McpAppSandbox, hostSandboxFrames } = require(path.join(dir, "sandbox.cjs"));
  const sandbox = new McpAppSandbox();
  await sandbox.start({ session: session.defaultSession, direct: [] });
  const registrations = new Set();
  ipcMain.handle("sandbox:register", async (event, doc) => {
    const registration = await sandbox.register(event.sender.id, doc);
    registrations.add(registration.id);
    return registration;
  });
  ipcMain.on("sandbox:release", (event, id) => {
    sandbox.release(event.sender.id, id);
    registrations.delete(id);
  });
  const win = new BrowserWindow({ show: false, width: 1000, height: 950, webPreferences: { preload: path.join(dir, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  hostSandboxFrames(win.webContents);
  const read = (code) => win.webContents.executeJavaScript(code);
  const view = () => win.webContents.mainFrame.frames.flatMap((frame) => frame.frames).find((frame) => frame.url.endsWith("/view"));
  const waitFor = async (predicate, label) => {
    for (let i = 0; i < 100; i++) {
      if (await predicate()) return;
      await pause(100);
    }
    throw Error("Timed out: " + label);
  };
  const ready = () =>
    waitFor(
      async () => view() && (await view().executeJavaScript("!!document.getElementById('next')")) && !(await read("document.body.innerText")).includes("Loading visualization"),
      "visualization ready",
    );
  const click = async (name) => {
    await read(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(name)}).click()`);
    await pause(100);
  };
  try {
    await win.loadFile(path.join(dir, "index.html"));
    await ready();
    assert.equal(await read(`document.querySelector('[aria-label="Agent work"]') === null`), true, "visual stays outside work");
    const isolation = await view().executeJavaScript(`(async()=>{
      let isolated=false,network=false,storage=false,evaluation=false;
      try{parent.document.body}catch{isolated=true}
      try{await fetch('https://example.invalid/blocked')}catch{network=true}
      try{localStorage.setItem('probe','blocked')}catch{storage=true}
      try{eval('1')}catch{evaluation=true}
      return {isolated,network,storage,evaluation,node:typeof require,bridge:typeof window.openorc};
    })()`);
    assert.deepEqual(isolation, { isolated: true, network: true, storage: true, evaluation: true, node: "undefined", bridge: "undefined" });
    assert.deepEqual(await peerContacts(view()), { datagrams: 0, connections: 0 }, "WebRTC in the visual, or in a frame it writes, reaches nothing");
    for (let step = 1; step <= 4; step++) await view().executeJavaScript(`document.getElementById('next').click()`);
    assert.match(await view().executeJavaScript("document.getElementById('status').textContent"), /Found 32 in four comparisons/);
    assert.equal(await view().executeJavaScript("document.getElementById('next').disabled"), true);
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    await view().executeJavaScript(`document.getElementById('back').focus()`);
    await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await waitFor(async () => (await view().executeJavaScript("document.getElementById('step').textContent")) === "3 / 4 comparisons", "keyboard control");
    await click("Reset");
    await ready();
    assert.match(await view().executeJavaScript("document.getElementById('status').textContent"), /Start with all 16/);
    for (const width of [1000, 390, 320]) {
      win.setSize(width, 1100);
      await pause(200);
      for (let mode = 0; mode < 2; mode++) {
        const theme = await read("document.documentElement.dataset.theme");
        await waitFor(async () => (await view().executeJavaScript("document.documentElement.dataset.theme")) === theme, "theme propagation");
        assert.equal(await read("document.documentElement.scrollWidth<=innerWidth"), true, "host layout fits");
        assert.equal(await view().executeJavaScript("document.documentElement.scrollWidth<=innerWidth"), true, "visual layout fits");
        const height = await read("parseFloat(document.querySelector('iframe').style.height)");
        assert.ok(height >= 120 && height < 800, "frame sizes to content");
        await fs.writeFile(path.join(dir, `${theme}-${width}.png`), (await win.webContents.capturePage()).toPNG());
        await click("Switch theme");
      }
    }
    for (const provider of ["Claude Code", "OpenCode", "Codex"]) {
      await click(provider);
      await ready();
    }
    await click("Toggle activity");
    await ready();
    await click("Reload history");
    await ready();
    await click("Hide visualization");
    await waitFor(() => !view() && registrations.size === 0, "release on hide");
    assert.match(await read("document.body.innerText"), /Each comparison removes half/);
    await click("Show visualization");
    await ready();
    assert.equal(registrations.size, 1);
    await click("Broken example");
    await waitFor(async () => /Example script failed/.test(await read("document.body.innerText")), "readable runtime error");
    await click("Codex");
    await ready();
    assert.equal(registrations.size, 1, "replaced views release registrations");
    console.log("PASS: interaction, keyboard, provider names, saved history, themes, 320px layout, sizing, reset, release, errors, isolation and no WebRTC contact. Captures: " + dir);
  } finally {
    win.destroy();
    await sandbox.close();
    app.quit();
  }
}

/**
 * What reaches a STUN and a TURN server on loopback from WebRTC in the view and in a frame the view writes itself, which
 * no policy refuses: datagrams over UDP and connections over TCP.
 */
async function peerContacts(frame) {
  const udp = require("node:dgram").createSocket("udp4");
  const tcp = require("node:net").createServer((socket) => socket.destroy());
  const seen = { datagrams: 0, connections: 0 };
  udp.on("message", () => seen.datagrams++);
  tcp.on("connection", () => seen.connections++);
  await new Promise((resolve) => udp.bind(0, "127.0.0.1", resolve));
  await new Promise((resolve) => tcp.listen(0, "127.0.0.1", resolve));
  const servers = JSON.stringify([{ urls: `stun:127.0.0.1:${udp.address().port}` }, { urls: `turn:127.0.0.1:${tcp.address().port}?transport=tcp`, username: "probe", credential: "probe" }]);
  const peer = `const pc=new RTCPeerConnection({iceServers:${servers}});pc.createDataChannel('probe');pc.createOffer().then(o=>pc.setLocalDescription(o));`;
  await frame.executeJavaScript(`${peer}const f=document.createElement('iframe');f.style.display='none';f.srcdoc=${JSON.stringify(`<script>${peer}<\/script>`)};document.body.append(f);`);
  await pause(3000);
  udp.close();
  tcp.close();
  return seen;
}

/** A loopback-only review fixture for OpenOrc's shared Preview, with the production sandbox. */
async function preview(dir) {
  const { McpAppSandbox } = require(path.join(dir, "sandbox.cjs"));
  const sandbox = new McpAppSandbox();
  await sandbox.start();
  let origin;
  const server = require("node:http").createServer(async (req, res) => {
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (req.method === "POST" && req.url === "/sandbox") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const data = JSON.parse(Buffer.concat(chunks).toString());
        if (data.release) {
          sandbox.release(1, data.release);
          res.end("{}");
        } else {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(await sandbox.register(1, data)));
        }
        return;
      }
      const pathname = new URL(req.url, origin).pathname;
      if (req.method !== "GET" || (pathname !== "/" && !/^\/assets\/[\w.-]+$/.test(pathname))) {
        res.writeHead(404).end();
        return;
      }
      let content = await fs.readFile(path.join(dir, pathname === "/" ? "index.html" : pathname));
      if (pathname === "/")
        content = content
          .toString()
          .replace(
            "<head>",
            `<head><script>window.openorc={mcpApps:{register:doc=>fetch('/sandbox',{method:'POST',body:JSON.stringify(doc)}).then(r=>r.json()),release:id=>fetch('/sandbox',{method:'POST',body:JSON.stringify({release:id})})}}</script>`,
          );
      const mime = { "/": "text/html", ".js": "application/javascript", ".css": "text/css" };
      res.setHeader("content-type", mime[pathname === "/" ? "/" : path.extname(pathname)] ?? "application/octet-stream");
      res.end(content);
    } catch {
      res.writeHead(500).end("Fixture unavailable");
    }
  });
  server.listen(0, "127.0.0.1", () => {
    origin = `http://127.0.0.1:${server.address().port}`;
    console.log("Visualization preview: " + origin);
  });
}

(process.versions.electron ? check() : build()).catch((error) => {
  console.error(error);
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
