import { audit, Db } from "@openorc/db";
import path from "node:path";
import { AttachmentService } from "../services/attachments.js";
import type { Handlers } from "./types.js";
type Dependencies = {
  db: Db;
  dataDir: string;
};

export function createAttachmentsHandlers({ db, dataDir }: Dependencies): Pick<Handlers, "attachments.save" | "attachments.saveFile"> {
  return {
    "attachments.save": async ({ name, mime, dataBase64 }) => {
      const saved = await new AttachmentService(dataDir).save({ name, mime, dataBase64 });
      audit.record(db, { actor: "user", action: "attachment.save", resourceType: "attachment", resourceId: path.basename(saved.path), metadata: { name, mime } });
      return saved;
    },
    "attachments.saveFile": async ({ name, dataBase64 }) => {
      const saved = await new AttachmentService(dataDir).saveFile({ name, dataBase64 });
      audit.record(db, { actor: "user", action: "attachment.save", resourceType: "attachment", resourceId: path.basename(saved.path), metadata: { name, bytes: saved.bytes } });
      return saved;
    },
  };
}
