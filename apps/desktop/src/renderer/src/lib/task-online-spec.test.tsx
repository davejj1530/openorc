import { expect, it } from "vitest";
import { validateOnlineTaskSpec } from "./task-online-spec";

it("refuses device images but keeps prose, code examples and shared addresses", () => {
  for (const destination of ["openorc-asset://attachments/image.png", "openorc-pending://draft", "file:///tmp/image.png", "/tmp/image.png", "./image.png"]) {
    expect(() => validateOnlineTaskSpec(`![Plan](${destination})`)).toThrow("only on this device");
    expect(() => validateOnlineTaskSpec(`<img src="${destination}">`)).toThrow("only on this device");
  }
  expect(() => validateOnlineTaskSpec("![Plan][image]\n\n[image]: ../image.png")).toThrow();
  for (const spec of ["Discuss /tmp/image.png and openorc-asset:// syntax.", "`![Plan](./image.png)`", "```md\n![Plan](./image.png)\n```", "![Plan](https://example.com/image.png)"])
    expect(() => validateOnlineTaskSpec(spec)).not.toThrow();
});
