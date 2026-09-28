/** The conversation's tail presence: a WebGPU orb that rests between turns and stirs during one. */
const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");
const desktop = path.resolve(__dirname, "../apps/desktop");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function buildAndRun() {
  const dir = await fs.mkdtemp("/tmp/openorc-team-ui-");
  await require("./build-transcript-fixture.cjs")(dir, "team-conversation-ui.tsx");
  const env = { ...process.env, OPENORC_TEAM_UI_DIR: dir };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require("node:child_process").spawn(require(require.resolve("electron", { paths: [desktop] })), [__filename], { env, stdio: "inherit" });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}

async function checkUI() {
  const { app, BrowserWindow } = require("electron");
  const dir = process.env.OPENORC_TEAM_UI_DIR;
  app.setPath("userData", path.join(dir, "electron-profile"));
  setTimeout(() => {
    console.error("Team UI smoke exceeded 60 seconds");
    app.exit(1);
  }, 60000).unref();
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { backgroundThrottling: false } });
  const errors = [];
  win.webContents.on("console-message", (event) => {
    if (event.level === "error") errors.push(event.message);
  });
  const read = async (code) => {
    try {
      return await win.webContents.executeJavaScript(code);
    } catch (error) {
      throw new Error(`${code}\n${errors.join("\n")}`, { cause: error });
    }
  };
  const shot = async (name) => fs.writeFile(path.join(dir, name + ".png"), (await win.webContents.capturePage()).toPNG());
  const until = async (code) => {
    for (let i = 0; i < 100; i++) {
      if (await read(`Boolean(${code})`)) return;
      await pause(100);
    }
    await shot("failure");
    throw Error(`Timed out: ${code}\n${errors.join("\n")}`);
  };
  const activityToggle = `Array.from(document.querySelectorAll('.team-conversation-heading button')).find(button => button.textContent === 'Show activity')`;
  const orb = `document.querySelector('.agent-orb')`;

  try {
    console.log("Loading team conversation");
    await win.loadFile(path.join(dir, "index.html"));
    console.log("Checking conversation");
    await until(`window.teamSmoke`);
    await read(`teamSmoke.theme('light')`);
    await pause(200);
    await until(`${activityToggle}`);
    assert.match(await read(`document.body.innerText`), /Seen by Lead, Sol 1/);
    assert.equal(await read(`document.querySelector('.work-toggle')`), null);
    assert.equal(await read(`document.querySelector('.team-ambient-work').getBoundingClientRect().height`), 0, "silent members take no space in quiet mode");
    assert.equal(await read(`document.querySelectorAll('.team-turn-ambient').length`), 0);
    assert.equal(await read(`document.querySelector('[data-team-chat="chat"] code')?.textContent`), "claude auth status", "member messages render inline code like ordinary replies");
    assert.equal(await read(`document.querySelectorAll('[data-team-chat="chat"] ol li').length`), 2, "member messages render real lists");
    assert.equal(await read(`document.querySelector('.team-chat-note')`), null);
    assert.equal(await read(`document.body.innerText.includes('pnpm check-part-0')`), false);
    assert.ok(await read(`document.body.innerText.includes('The changes are ready for review.')`));
    for (const theme of ["light", "dark"]) {
      await read(`teamSmoke.theme(${JSON.stringify(theme)}); teamSmoke.streamReply('Streaming reply')`);
      await until(`document.querySelector('[data-team-run="sol1"]')?.innerText.includes('Streaming reply')`);
      assert.equal(await read(`document.querySelector('[data-team-run="sol1"] .work-section')`), null, "streaming text is visible with activity hidden");
      await read(`teamSmoke.streamReply('Streaming reply before the turn finishes.')`);
      await until(`document.querySelector('[data-team-run="sol1"]')?.innerText.includes('Streaming reply before the turn finishes.')`);
      await pause(250);
      await shot(`team-streaming-${theme}`);
      await read(`${activityToggle}.click()`);
      await until(`document.querySelector('[data-team-run="sol1"] .work-section')`);
      assert.equal(await read(`document.querySelector('[data-team-run="sol1"] .work-section').innerText.includes('Streaming reply')`), false, "reply is separate from work");
      await read(`${activityToggle}.click()`);
      await until(`document.querySelector('[data-team-run="sol1"] .work-section') === null`);
      assert.equal(await read(`document.querySelector('[data-team-run="sol1"]').innerText.includes('Streaming reply before the turn finishes.')`), true);
      await read(`teamSmoke.streamReply('Streaming reply before the turn finishes.', true)`);
      await until(`document.querySelector('[data-team-run="sol1"]')?.innerText.includes('Streaming reply before the turn finishes.')`);
      assert.equal(
        await read(`document.querySelector('[data-team-run="sol1"]').innerText.split('Streaming reply before the turn finishes.').length - 1`),
        1,
        "settlement does not duplicate the reply",
      );
    }
    await read(`teamSmoke.theme('light'); teamSmoke.streamReply('The changes are ready for review. All checks passed.', true)`);
    await read(`teamSmoke.everyone()`);
    await until(`document.body.innerText.includes('Seen by everyone')`);
    await until(`${orb}?.querySelector('canvas')`);
    await until(`${orb}.querySelector('canvas').style.opacity === '1'`);
    assert.equal(await read(`${orb}.dataset.state`), "idle");
    console.log("Capturing light theme");
    await shot("team-light");
    await read(`teamSmoke.theme('dark')`);
    win.setSize(760, 900);
    await pause(300);
    assert.equal(await read(`document.documentElement.scrollWidth > innerWidth`), false);
    await shot("team-dark-narrow");
    await until(`document.querySelector('.change-card')?.textContent.includes('+2')`);
    await until(`document.querySelectorAll('.change-files li').length === 2`);
    await read(`document.querySelector('.change-card').scrollIntoView({block: 'center'})`);
    await shot("team-change-card");
    win.setSize(1400, 900);
    await read(`Array.from(document.querySelectorAll('.change-card button')).find(button => button.textContent === 'Review').click()`);
    await until(`document.querySelector('.panel-shell')?.dataset.open === 'true' && document.querySelectorAll('.diff-file').length === 2`);
    assert.deepEqual(await read(`teamSmoke.reviewCalls.findLast(call => call.includePatch).paths`), ["src/app.ts", "src/theme.css"]);
    await pause(300);
    await shot("team-review-sidebar");
    await read(`document.querySelector('.change-files li button').click()`);
    await until(`document.querySelectorAll('.diff-file').length === 1`);
    assert.equal(await read(`document.querySelector('.diff-file').getAttribute('aria-label')`), "src/app.ts");
    assert.deepEqual(await read(`teamSmoke.reviewCalls.findLast(call => call.includePatch).paths`), ["src/app.ts"]);
    await until(`document.querySelector('diffs-container')?.shadowRoot?.textContent.includes('saved value')`);
    await shot("team-review-one-file");
    await read(`teamSmoke.theme('light')`);
    await pause(200);
    await shot("team-review-light");
    await read(`teamSmoke.theme('dark')`);
    await read(`document.querySelector('[aria-label="Hide panel"]').click()`);
    await pause(300);
    win.setSize(760, 900);
    await read(`${activityToggle}.click()`);
    await until(`document.querySelector('.work-toggle')`);
    await read(`document.querySelector('.work-toggle').click()`);
    await until(`document.querySelector('.work-toggle').getAttribute('aria-expanded') === 'true'`);
    await until(`document.querySelector('.work-content').textContent.includes('Checking the implementation')`);
    await read(`document.querySelector('.work-content .work-step-toggle').click()`);
    await until(`document.querySelector('.work-content').textContent.includes('pnpm check-part-0')`);
    await read(`document.querySelector('.work-toggle').scrollIntoView({block: 'start'})`);
    await pause(200);
    await shot("team-expanded");
    await read(`${activityToggle}.click(); teamSmoke.approval()`);
    await until(`document.querySelector('[data-blocking="true"]')`);
    assert.equal(await read(`document.querySelector('.work-toggle')`), null);
    await read(`teamSmoke.working()`);
    await until(`${orb}.dataset.state === 'thinking'`);
    assert.equal(await read(`document.querySelector('.team-activity-strip')`), null);
    await until(`document.querySelector('[data-team-working]')?.textContent.includes('Sol 1 is working')`);
    assert.equal(await read(`document.querySelectorAll('.agent-orb').length`), 1);
    await shot("team-working-approval");

    assert.equal(await read(`${activityToggle}.getAttribute('aria-pressed')`), "false");
    await read(`${activityToggle}.click()`);
    await until(`${activityToggle}.getAttribute('aria-pressed') === 'true'`);
    await until(`document.querySelector('.team-activity-strip')?.textContent.includes('Needs your input')`);
    await read(`${activityToggle}.click()`);
    await until(`document.querySelector('.team-activity-strip') === null`);
    // Hydration must discover a request inside an assignment that was never expanded.
    await read(`teamSmoke.nestedQuestion()`);
    await until(`document.querySelector('.team-attention select')?.options.length === 2`);
    assert.equal(await read(`document.querySelector('[data-team-actor="assignment"] .team-member-toggle').getAttribute('aria-expanded')`), "false");
    const select = `document.querySelector('.team-attention select')`;
    await read(`${select}.value = 'approval:assignment:nested-question'; ${select}.dispatchEvent(new Event('change', {bubbles: true}))`);
    await until(`document.querySelector('.team-attention-content:not([hidden]) input')`);
    const answer = `document.querySelector('.team-attention-content:not([hidden]) input')`;
    await read(`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(${answer}, 'Changed files only'); ${answer}.dispatchEvent(new Event('input', {bubbles: true}))`);
    await read(`${select}.value = 'approval:sol1:approval'; ${select}.dispatchEvent(new Event('change', {bubbles: true}))`);
    await read(`${select}.value = 'approval:assignment:nested-question'; ${select}.dispatchEvent(new Event('change', {bubbles: true}))`);
    assert.equal(await read(`${answer}.value`), "Changed files only");
    await read(`Array.from(document.querySelectorAll('.team-attention button')).find(button => button.textContent === 'View context').click()`);
    await until(`document.querySelector('[data-team-actor="assignment"] .team-member-toggle').getAttribute('aria-expanded') === 'true'`);
    await until(`document.activeElement.dataset.teamRequest === "approval:assignment:nested-question"`);
    // The attention area is outside transcript scrolling and leaves the composer visible.
    win.setSize(600, 820);
    await pause(200);
    assert.equal(await read(`document.documentElement.scrollWidth > innerWidth`), false);
    assert.ok(await read(`document.querySelector('.team-attention').getBoundingClientRect().bottom < innerHeight`));
    assert.ok(await read(`document.querySelector('[contenteditable="true"], textarea').getBoundingClientRect().bottom <= innerHeight`));
    await shot("team-pinned-question-narrow");
    await read(`teamSmoke.theme('light')`);
    win.setSize(1100, 900);
    await pause(200);
    await shot("team-pinned-question-light");
    await read(`Array.from(document.querySelectorAll('.team-attention-content:not([hidden]) button')).find(button => button.textContent === 'Answer').click()`);
    await until(`!document.querySelector('.team-attention select')`);
    assert.deepEqual(await read(`teamSmoke.approvalCalls.at(-1)`), { runId: "assignment", approvalId: "nested-question", decision: "allow", answers: { scope: ["Changed files only"] } });
    await read(`Array.from(document.querySelectorAll('.team-attention button')).find(button => button.textContent === 'Deny').click()`);
    await until(`!document.querySelector('.team-attention')`);
    assert.equal(await read(`teamSmoke.approvalCalls.at(-1).decision`), "deny");
    await read(`teamSmoke.finish()`);
    await until(`document.querySelector('.team-execution').lastElementChild?.dataset.teamMember === 'sol1'`);
    // Saved preference applies to a fresh render as well as the current live turn.
    await read(`${activityToggle}.click()`);
    await until(`${activityToggle}.getAttribute('aria-pressed') === 'true'`);
    await win.loadFile(path.join(dir, "index.html"));
    await until(`window.teamSmoke && ${activityToggle}?.getAttribute('aria-pressed') === 'true'`);
    await read(`${activityToggle}.click()`);
    await until(`${activityToggle}.getAttribute('aria-pressed') === 'false'`);
    await win.loadFile(path.join(dir, "index.html"));
    await until(`window.teamSmoke && ${activityToggle}?.getAttribute('aria-pressed') === 'false'`);

    assert.deepEqual(errors, []);
    console.log("team conversation UI smoke passed; screenshots in", dir);
    app.exit(0);
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
}

if (process.versions.electron) void checkUI();
else void buildAndRun();
