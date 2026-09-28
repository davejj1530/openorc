/** Disposable Electron test of the real Slack settings panel, backed by fixture RPCs. */
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const desktop = path.resolve(__dirname, "../apps/desktop");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function main() {
  if (!process.versions.electron) {
    const dir = await fs.mkdtemp("/tmp/openorc-slack-ui-");
    await require("./build-transcript-fixture.cjs")(dir, "slack-settings-ui.tsx");
    const env = { ...process.env, OPENORC_SLACK_SMOKE: dir };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require("node:child_process").spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
    child.on("exit", (code) => {
      process.exitCode = code ?? 1;
    });
    return;
  }
  const { app, BrowserWindow } = require("electron");
  const dir = process.env.OPENORC_SLACK_SMOKE;
  app.setPath("userData", path.join(dir, "profile"));
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1280, height: 980, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on("console-message", (e) => {
    if (e.level === "error") errors.push(e.message);
  });
  const read = (code) => win.webContents.executeJavaScript(code);
  const until = async (code) => {
    for (let i = 0; i < 80; i++) {
      if (await read(code)) return;
      await pause(100);
    }
    throw new Error(`Timed out: ${code}`);
  };
  const field = (label) =>
    `Array.from(document.querySelectorAll('label')).find(e=>e.getClientRects().length && e.querySelector('.font-medium')?.textContent===${JSON.stringify(label)}).querySelector('input,select')`;
  const fill = (label, value) =>
    read(
      `(()=>{const e=${field(label)};Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`,
    );
  const button = (name) => `Array.from(document.querySelectorAll('button')).find(e=>e.getClientRects().length && e.textContent===${JSON.stringify(name)})`;
  const click = (name) => read(`${button(name)}.click()`);
  const captures = [];
  const shot = async (name, theme, width, host) => {
    win.setSize(width, 980);
    await read(`(()=>{document.documentElement.dataset.theme=${JSON.stringify(theme)};const scroller=document.querySelector('.settings-content');scroller.scrollTop=${scrollTarget(host)};})()`);
    await pause(250);
    const file = path.join(dir, `${name}.png`);
    await fs.writeFile(file, (await win.webContents.capturePage()).toPNG());
    captures.push(file);
    assert(
      await read(`document.documentElement.scrollWidth<=innerWidth && document.querySelector('.settings-content').scrollWidth<=document.querySelector('.settings-content').clientWidth`),
      "No horizontal overflow",
    );
  };
  try {
    await win.loadFile(path.join(dir, "index.html"));
    await until(`${button("Connect and check")} && !${field("Bot token")}.disabled`);
    assert.equal(await read(`${field("Connect Slack")}.value`), "direct");
    assert.equal(
      await read(`Array.from(document.querySelectorAll('label')).filter(e=>e.getClientRects().length).some(e=>e.textContent.includes('Relay address')||e.textContent.includes('Device key'))`),
      false,
    );
    await click("Create Slack app");
    assert.equal(await read("slackSmoke.calls.some(c=>c.startsWith('open:https://api.slack.com/apps?new_app=1&manifest_json='))"), true);
    await shot("personal-setup-dark-900", "dark", 900, false);
    await fill("Bot token", "xoxb-personal-fixture");
    await fill("App token", "xapp-personal-fixture");
    await fill("Your Slack member ID", "UALICE");
    await fill("Mode", "autonomous");
    await read("slackSmoke.fail()");
    await click("Connect and check");
    await until("document.querySelector('[role=status]')?.textContent.includes('users:read')");
    assert.equal(await read(`${field("Bot token")}.value`), "");
    assert.equal(await read(`${field("App token")}.value`), "");
    await until(`!${button("Connect and check")}.disabled`);
    await click("Connect and check");
    await until("document.body.textContent.includes('Alice · Personal workspace')");
    assert.equal(await read(`${field("Connect Slack")}.disabled`), true);
    await shot("personal-connected-light-1280", "light", 1280, false);
    await shot("personal-connected-dark-900", "dark", 900, false);
    await shot("personal-bottom-dark-900", "dark", 900, "bottom");
    await click("Disconnect Slack");
    await until(`!${field("Connect Slack")}.disabled`);
    await fill("Connect Slack", "relay");
    await until(`${button("Save and connect relay")} && !${field("Bot token")}.disabled`);
    await read("Array.from(document.querySelectorAll('details')).find(e=>e.getClientRects().length).open=true");
    await fill("Bot token", "xoxb-fixture-token");
    await fill("App token", "xapp-fixture-token");
    assert.equal(await read(`${field("Bot token")}.type`), "password");
    await click("Save and connect relay");
    await until("document.body.textContent.includes('POC workspace')");
    assert.equal(await read(`${field("Bot token")}.value`), "");
    assert.equal(await read(`${field("App token")}.value`), "");
    await fill("Slack member ID", "UALICE");
    await fill("Device label", "Alice's Mac");
    await click("Register device");
    await until("document.body.textContent.includes('New device key')");
    assert.equal(await read(`${field("New device key")}.type`), "password");
    await fill("Device key", `oqd_${"a".repeat(64)}`);
    assert.equal(await read("document.body.textContent.includes('Workspace entrypoint')"), true);
    assert.deepEqual(await read(`Array.from(${field("Mode")}.options).map(o=>o.value)`), ["plan", "review", "trusted", "autonomous"]);
    await fill("Mode", "autonomous");
    await read("slackSmoke.fail()");
    await click("Connect this computer");
    await until("document.querySelector('[role=alert]')?.textContent.includes('Relay unavailable')");
    assert.equal(await read(`${field("Device key")}.value`), "");
    await until(`!${button("Connect this computer")}.disabled`);
    await click("Connect this computer");
    await until("document.body.textContent.includes('Slack user UALICE')");
    assert.equal(await read(`${field("Mode")}.value`), "autonomous");
    assert.equal(await read(`${button("Connect this computer")}.disabled`), true);
    for (const [theme, width] of [
      ["light", 1280],
      ["dark", 900],
    ]) {
      await shot(`desktop-${theme}-${width}`, theme, width, false);
      await shot(`host-${theme}-${width}`, theme, width, true);
      await shot(`host-bottom-${theme}-${width}`, theme, width, "bottom");
    }
    await click("Dismiss key");
    await read("slackSmoke.deliveryFailed()");
    await until("document.body.textContent.includes('Delivery pending')");
    assert.equal(await read("document.body.textContent.includes('This computer is connected.')"), false, "A delivery error hides stale connection success");
    await read("slackSmoke.fail()");
    await click("Retry Slack delivery");
    await until("document.querySelector('[role=alert]')?.textContent.includes('Relay unavailable')");
    await until(`!${button("Retry Slack delivery")}.disabled`);
    await click("Retry Slack delivery");
    await until("document.body.textContent.includes('Desktop connection checked and pending delivery retried.')");
    assert.equal(await read("document.body.textContent.includes('Delivery pending')"), false);
    await click("Disconnect desktop");
    await until(`!${button("Connect this computer")}.disabled`);
    assert.equal(await read(`${field("Mode")}.value`), "autonomous");
    assert.equal(errors.length, 0, errors.join("\n"));
    console.log(
      JSON.stringify(
        {
          passed: true,
          captures,
          checks:
            "personal manifest/setup/connect/failure/retry, owner and defaults, legacy relay setup, masked and cleared secrets, device registration, failure/retry, desktop connection/disconnection, two themes and widths",
        },
        null,
        2,
      ),
    );
  } finally {
    win.destroy();
    app.quit();
  }
}
main().catch((error) => {
  console.error(error);
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});

function scrollTarget(host) {
  if (host === "bottom") return "scroller.scrollHeight";
  if (host) return "scroller.scrollTop + Array.from(document.querySelectorAll('details')).find(e=>e.getClientRects().length).getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16";
  return "0";
}
