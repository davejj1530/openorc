import { expect, it } from "vitest";
import { hear, HEARD_NOTHING, heardWords, pickLanguage, withSpoken } from "./spoken";

it("writes spoken words at the caret with a space on either side where the message needs one", () => {
  expect(withSpoken({ text: "Fix the build", from: 13, to: 13 }, "and run the tests")).toEqual({ text: "Fix the build and run the tests", caret: 31 });
  expect(withSpoken({ text: "Fix build", from: 4, to: 4 }, "the")).toEqual({ text: "Fix the build", caret: 7 });
  expect(withSpoken({ text: "", from: 0, to: 0 }, "Hello")).toEqual({ text: "Hello", caret: 5 });
});

it("speaks over what was selected, and leaves it alone while nothing is heard", () => {
  const place = { text: "Fix the build today", from: 8, to: 13 };
  expect(withSpoken(place, "tests")).toEqual({ text: "Fix the tests today", caret: 13 });
  expect(withSpoken(place, "")).toEqual({ text: "Fix the build today", caret: 8 });
});

it("joins what a recognizer settles a pause at a time with what it is still making out", () => {
  let heard = hear(HEARD_NOTHING, "open the", false);
  heard = hear(heard, "Open the composer", false);
  expect(heardWords(heard)).toBe("Open the composer");
  heard = hear(heard, "Open the composer.", true);
  heard = hear(heard, " then run", false);
  expect(heardWords(heard)).toBe("Open the composer. then run");
  heard = hear(heard, " Then run the checks.", true);
  expect(heardWords(heard)).toBe("Open the composer. Then run the checks.");
});

it("recognizes in the device's language where it has a model, else in another form of it, else not at all", () => {
  const onDevice = ["de-DE", "en-GB", "en-US", "fr-CA", "fr-FR"];
  expect(pickLanguage("en-GB", onDevice)).toBe("en-GB");
  expect(pickLanguage("en_PH", onDevice)).toBe("en-US");
  expect(pickLanguage("fr-BE", onDevice)).toBe("fr-FR");
  expect(pickLanguage("de-AT", ["de-CH"])).toBe("de-CH");
  expect(pickLanguage("ja-JP", onDevice)).toBeNull();
});
