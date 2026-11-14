import { expect, it } from "vitest";
import { z } from "zod";
import { AccountCache } from "./account-cache.js";

it("partitions snapshots by server and stable account identity and removes only the signed-out account", () => {
  let json: string | null = null;
  const kept = {
    load: () => json,
    save: (_part: string, value: string | null) => {
      json = value;
    },
  };
  const schema = z.object({ rows: z.array(z.string()) });
  const a = new AccountCache({ kept, part: "threads", server: "https://one.example.com", schema });
  const b = new AccountCache({ kept, part: "threads", server: "https://two.example.com", schema });
  a.save("u1", "member@example.com", { rows: ["one"] });
  b.save("u2", "member@example.com", { rows: ["two"] });
  a.save("u3", "other@example.com", { rows: ["other"] });
  expect(a.load("member@example.com")).toEqual({ rows: ["one"] });
  expect(b.load("member@example.com")).toEqual({ rows: ["two"] });
  a.forget("u1");
  expect(a.load("member@example.com")).toBeNull();
  expect(a.load("other@example.com")).toEqual({ rows: ["other"] });
  expect(b.load("member@example.com")).toEqual({ rows: ["two"] });
});
