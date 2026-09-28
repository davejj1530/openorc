import { ReviewerAppService } from "../services/reviewer-app.js";
import type { Handlers } from "./types.js";

type Dependencies = { reviewerApp: ReviewerAppService };
type ReviewerAppMethod = Extract<keyof Handlers, `reviewerApp.${string}`>;

export function createReviewerAppHandlers({ reviewerApp }: Dependencies): Pick<Handlers, ReviewerAppMethod> {
  return {
    "reviewerApp.get": () => reviewerApp.status(),
    "reviewerApp.setup": () => reviewerApp.setup(),
    "reviewerApp.cancelSetup": () => {
      reviewerApp.cancel();
      return null;
    },
    "reviewerApp.configure": ({ allowApprove }) => {
      reviewerApp.configure(allowApprove);
      return null;
    },
    "reviewerApp.remove": async () => {
      await reviewerApp.remove();
      return null;
    },
  };
}
