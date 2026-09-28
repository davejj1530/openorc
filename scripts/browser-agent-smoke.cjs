/** Real MCP -> utility process -> main bridge -> sandboxed sidebar WebContentsView. No user profile or provider calls. */
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const desktop = path.join(root, "apps/desktop");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildAndRun() {
  const dir = await fs.mkdtemp("/tmp/openorc-browser-agent-");
  const { build } = require(require.resolve("esbuild", { paths: [path.dirname(require.resolve("tsx/package.json", { paths: [root] }))] }));
  for (const [name, entry] of Object.entries({ pane: "apps/desktop/src/main/browser-pane.ts", bridge: "apps/desktop/src/main/browser-bridge.ts", preload: "apps/desktop/src/preload/index.ts" })) {
    await build({
      entryPoints: [path.join(root, entry)],
      outfile: path.join(dir, `${name}.cjs`),
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron"],
      define: { __OPENORC_QA__: "false" },
    });
  }
  await build({
    stdin: {
      resolveDir: root,
      contents: `
      import { BrowserClient } from './apps/desktop/src/core/browser-client.ts';
      import { startMcpServer } from './packages/mcp/src/index.ts';
      const browser = new BrowserClient(message => process.parentPort.postMessage(message));
      process.parentPort.on('message', event => browser.receive(event.data));
      startMcpServer({ browser: (runId, command) => browser.execute('thread:' + runId, command) }).then(server => {
        process.parentPort.postMessage({ type: 'fixture.ready', a: server.urlForRun('a'), b: server.urlForRun('b') });
      });
    `,
    },
    outfile: path.join(dir, "core.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  await fs.writeFile(
    path.join(dir, "host.html"),
    `<!doctype html><title>Browser smoke host</title><body><h1>Conversation fixture</h1><script>
    let surface = 'thread:a';
    let shown = null;
    let reveal = Promise.resolve();
    window.openorc.browser.onReveal(id => {
      if (id !== surface) return;
      reveal = window.openorc.browser.show({ id, bounds: { x: 250, y: 70, width: 700, height: 620 }, url: 'http://localhost:3000' }).then(() => { shown = id; });
    });
    window.openorc.browser.setContext(surface);
    window.smoke = {
      shown: () => shown,
      select(id) { if (shown) window.openorc.browser.hide(shown); shown = null; surface = id; window.openorc.browser.setContext(id); },
      ready: () => reveal,
    };
  </script>`,
  );
  const env = { ...process.env, OPENORC_BROWSER_SMOKE: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

async function check() {
  const { app, BrowserWindow, ipcMain, utilityProcess, nativeImage } = require("electron");
  const dir = process.env.OPENORC_BROWSER_SMOKE;
  app.setPath("userData", path.join(dir, "profile"));
  // A non-localhost origin with deterministic content and no system DNS edits.
  app.commandLine.appendSwitch("host-resolver-rules", "MAP preview.example.test 127.0.0.1");
  await app.whenReady();
  const { installBrowserPane, closeAllPanes } = require(path.join(dir, "pane.cjs"));
  const { executeBrowserCommand } = require(path.join(dir, "pane.cjs"));
  const { installBrowserBridge } = require(path.join(dir, "bridge.cjs"));
  const server = require("node:http").createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: publicSite + "/redirected" }).end();
      return;
    }
    if (req.url === "/frame") {
      res.end('<script>parent.postMessage("Public frame loaded", "*")</script>');
      return;
    }
    if (req.url === "/slow") {
      setTimeout(() => res.end("<title>Slow</title>Slow page"), 700);
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html><title>Local fixture ${req.url}</title><style>body{font:18px sans-serif;background:#fff;color:#222;padding:24px}button,input{font:inherit;margin:12px}footer{margin-top:1600px}</style>
      <h1>Website in the sidebar</h1><form><label>Name <input id="name"></label><button>Greet</button></form><p id="result">Waiting</p>
      <a href="/next">Next page</a><a href="${publicSite}/linked">Public website</a><div id="shadow"></div><p id="frame-status"></p><footer>Bottom of page</footer><script>
      addEventListener('message', e => { if (e.origin === '${publicSite}' && e.data === 'Public frame loaded') document.querySelector('#frame-status').textContent = e.data; });
      document.querySelector('form').onsubmit = e => { e.preventDefault(); document.querySelector('#result').textContent = 'Hello ' + document.querySelector('#name').value; };
      document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML = '<button>Shadow button</button>';
      document.querySelector('#shadow').shadowRoot.querySelector('button').onclick = () => { document.querySelector('#result').textContent = 'Shadow clicked'; };
      </script><iframe title="Public frame" src="${publicSite}/frame"></iframe>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const site = `http://127.0.0.1:${server.address().port}`;
  const publicSite = `http://preview.example.test:${server.address().port}`;
  const win = new BrowserWindow({
    show: false,
    width: 1050,
    height: 780,
    webPreferences: { preload: path.join(dir, "preload.cjs"), sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  installBrowserPane(ipcMain, { getWindow: () => win });
  await win.loadFile(path.join(dir, "host.html"));
  win.showInactive();
  const child = utilityProcess.fork(path.join(dir, "core.cjs"), [], { stdio: "pipe" });
  child.stderr.on("data", (data) => process.stderr.write(data));
  installBrowserBridge(child, executeBrowserCommand);
  const urls = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Fixture MCP did not start")), 10000);
    child.on("message", (msg) => {
      if (msg.type === "fixture.ready") {
        clearTimeout(timer);
        resolve(msg);
      }
    });
  });
  let calls = 0;
  const tool = async (who, args, error = false) => {
    const response = await fetch(urls[who], {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++calls, method: "tools/call", params: { name: "browser", arguments: args } }),
      signal: AbortSignal.timeout(40000),
    });
    const raw = await response.text();
    const reply = JSON.parse(
      raw.startsWith("{")
        ? raw
        : raw
            .split("\n")
            .find((line) => line.startsWith("data: "))
            .slice(6),
    );
    assert(!reply.error, JSON.stringify(reply));
    assert.equal(Boolean(reply.result.isError), error, JSON.stringify(reply.result).slice(0, 500));
    return error ? reply.result : { ...JSON.parse(reply.result.content[0].text), image: reply.result.content.find((item) => item.type === "image") };
  };
  const read = (code) => win.webContents.executeJavaScript(code);
  try {
    let result = await tool("a", { action: "open", url: site });
    await pause(120);
    await read("smoke.ready()");
    assert.equal(await read("smoke.shown()"), "thread:a");
    assert.equal(result.url, site + "/", "reveal must not replace the requested dev-server URL with the UI default");
    assert(result.snapshot.text.includes("Website in the sidebar"));
    assert(result.snapshot.elements.some((el) => el.name === "Shadow button"));
    const oldRef = result.snapshot.elements.find((el) => el.name === "Greet").ref;
    result = await tool("a", { action: "fill", ref: result.snapshot.elements.find((el) => el.name === "Name").ref, text: "OpenOrc" });
    result = await tool("a", { action: "click", ref: result.snapshot.elements.find((el) => el.name === "Greet").ref });
    assert(result.snapshot.text.includes("Hello OpenOrc"), JSON.stringify(result));
    await tool("a", { action: "click", ref: oldRef }, true);
    result = await tool("a", { action: "fill", ref: result.snapshot.elements.find((el) => el.name === "Name").ref, text: "Keyboard" });
    result = await tool("a", { action: "press", key: "Enter" });
    assert(result.snapshot.text.includes("Hello Keyboard"));
    result = await tool("a", { action: "click", ref: result.snapshot.elements.find((el) => el.name === "Shadow button").ref });
    assert(result.snapshot.text.includes("Shadow clicked"));
    result = await tool("a", { action: "screenshot" });
    const png = Buffer.from(result.image.data, "base64");
    assert(png.length > 1000);
    const size = nativeImage.createFromBuffer(png).getSize();
    assert(size.width >= 700 && size.height >= 620);
    await fs.writeFile(path.join(dir, "preview.png"), png);
    result = await tool("a", { action: "scroll", y: 600 });
    assert(result.snapshot.viewport.scrollY > 0);
    result = await tool("a", { action: "click", ref: result.snapshot.elements.find((el) => el.name === "Next page").ref });
    assert.equal(result.url, site + "/next");
    result = await tool("a", { action: "click", ref: result.snapshot.elements.find((el) => el.name === "Public website").ref });
    assert.equal(result.url, publicSite + "/linked");
    result = await tool("a", { action: "open", url: site + "/redirect" });
    assert.equal(result.url, publicSite + "/redirected");
    result = await tool("a", { action: "open", url: publicSite });
    assert.equal(result.url, publicSite + "/");
    assert(result.snapshot.text.includes("Website in the sidebar"));
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "openorc-asset://attachments/secret.png", "https://user:secret@example.com/"]) {
      await tool("a", { action: "open", url }, true);
    }
    result = await tool("a", { action: "open", url: site });
    assert(result.snapshot.text.includes("Public frame loaded"), "cross-origin public iframe must load");
    if (process.env.OPENORC_BROWSER_PUBLIC_URL) {
      result = await tool("a", { action: "open", url: process.env.OPENORC_BROWSER_PUBLIC_URL });
      assert(result.snapshot.text.length > 0, "live public website must return page content");
      console.log(JSON.stringify({ publicWebsite: result.url, title: result.title }));
      result = await tool("a", { action: "screenshot" });
      await fs.writeFile(path.join(dir, "public-preview.png"), Buffer.from(result.image.data, "base64"));
    }
    await tool("a", { action: "open", url: site });
    result = await tool("b", { action: "open", url: site + "/background" });
    result = await tool("b", { action: "fill", ref: result.snapshot.elements.find((el) => el.name === "Name").ref, text: "Background" });
    result = await tool("b", { action: "click", ref: result.snapshot.elements.find((el) => el.name === "Greet").ref });
    assert(result.snapshot.text.includes("Hello Background"), JSON.stringify(result));
    assert.equal(await read("smoke.shown()"), "thread:a", "background work must not change the selected conversation");
    result = await tool("b", { action: "screenshot" });
    assert(result.image.data.length > 1000, "hidden preview must still produce a real screenshot");
    await read("smoke.select('thread:b')");
    await pause(100);
    assert.equal(await read("smoke.shown()"), "thread:b");
    assert.equal((await tool("b", { action: "snapshot" })).url, site + "/background");
    await read("openorc.browser.close('thread:b')");
    await pause(50);
    await tool("b", { action: "snapshot" }, true);
    await tool("b", { action: "open", url: site + "/slow" });
    const second = new BrowserWindow({ show: false });
    await second.loadURL("data:text/html,<title>Other window</title>");
    result = await tool("b", { action: "snapshot" });
    assert.equal(result.title, "Slow");
    second.destroy();
    console.log(
      JSON.stringify({
        passed: true,
        calls,
        screenshot: path.join(dir, "preview.png"),
        checks: [
          "real utility bridge",
          "MCP image",
          "same sidebar view",
          "fill",
          "trusted click",
          "keyboard",
          "scroll",
          "shadow roots",
          "stale refs",
          "URL policy",
          "redirect policy",
          "public website opens and links",
          "cross-origin iframe",
          "background isolation",
          "hidden screenshot",
          "thread switching",
          "closed pane",
          "multiple windows",
        ],
      }),
    );
  } finally {
    child.kill();
    closeAllPanes();
    win.destroy();
    server.close();
    app.quit();
  }
}

if (process.versions.electron)
  check().catch((error) => {
    console.error(error);
    require("electron").app.exit(1);
  });
else
  buildAndRun().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
