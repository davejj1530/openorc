import { expect, it } from "vitest";
import { taskCreation } from "./task-requests.js";
import { Refused } from "./session.js";

it("lets a new task be corrected only after a definitive refusal", async () => {
  await expect(taskCreation(Promise.reject(new Refused("Choose another person.", 409, "TASK_ASSIGNEE_UNAVAILABLE")))).resolves.toEqual({
    state: "refused",
    code: "TASK_ASSIGNEE_UNAVAILABLE",
    message: "Choose another person.",
  });
  await expect(taskCreation(Promise.reject(new Error("Lost response")))).rejects.toThrow("Lost response");
  await expect(taskCreation(Promise.reject(new Refused("Try again", 503)))).rejects.toThrow("Try again");
});
