import { TeamChatFile } from "@openorc/protocol";
import { z } from "zod";
import type { Route } from "./wire.js";

export const uploadPlan = z.object({ id: z.string().min(1).max(64), partBytes: z.number().int().positive(), parts: z.number().int().positive() });
export type UploadPlan = z.infer<typeof uploadPlan>;
export const uploadedFile = TeamChatFile;
export type UploadedFile = z.infer<typeof uploadedFile>;
const signedParts = z.object({
  urls: z
    .array(z.object({ part: z.number().int().positive(), url: z.url() }))
    .min(1)
    .max(16),
});
const upload = (id: string) => `/uploads/${encodeURIComponent(id)}`;

export const FILE_ROUTES = {
  start: { method: "POST", path: "/uploads", reply: uploadPlan } satisfies Route<UploadPlan>,
  parts: (id: string): Route<z.infer<typeof signedParts>> => ({ method: "POST", path: `${upload(id)}/parts`, reply: signedParts }),
  complete: (id: string): Route<UploadedFile> => ({ method: "POST", path: `${upload(id)}/complete`, reply: uploadedFile }),
  cancel: (id: string): Route<null> => ({ method: "DELETE", path: upload(id), reply: null }),
};
