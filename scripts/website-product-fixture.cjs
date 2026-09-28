/** Build a safe, disposable production-renderer fixture for website captures. */
const path = require("node:path");
const fs = require("node:fs/promises");
const output = path.resolve(__dirname, "../output/qa/website-product");
(async () => {
  await fs.mkdir(output, { recursive: true });
  await require("./build-transcript-fixture.cjs")(output, "website-product-ui.tsx");
  console.log(
    `Fixture built: ${output}\nServe this folder locally, then capture ?view=workspace, ?view=review, ?view=teams, ?view=tasks, ?view=discussion, ?view=plan, ?view=delivery, and ?view=schedules. All data is synthetic; components and styles are the production app.`,
  );
})();
