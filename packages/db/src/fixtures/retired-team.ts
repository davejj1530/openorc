import type { Thread } from "@openorc/protocol";
import { randomUUID } from "node:crypto";
import type { Db } from "../database.js";

export function seedRetiredTeam(db: Db, thread: Thread) {
  const teamId = randomUUID(),
    revisionId = randomUUID(),
    instanceId = randomUUID();
  db.transaction(() => {
    db.stmt("INSERT INTO orchestration_teams(id,project_id,current_revision_id,created_at,updated_at) VALUES (?,?,?,1,1)").run(teamId, thread.projectId, revisionId);
    db.stmt("INSERT INTO orchestration_team_revisions(id,team_id,project_id,number,name,limits,sealed,created_at) VALUES (?,?,?,1,'Saved team','{}',0,1)").run(revisionId, teamId, thread.projectId);
    db.stmt(
      "INSERT INTO orchestration_team_members(revision_id,member_key,position,name,responsibility,manager_key,agent,model,effort,fast_mode) VALUES (?,'lead',0,'Lead','Review',NULL,'codex','fixture',NULL,0)",
    ).run(revisionId);
    db.stmt("UPDATE orchestration_team_revisions SET sealed=1 WHERE id=?").run(revisionId);
    db.stmt("INSERT INTO orchestration_team_instances(id,thread_id,project_id,team_revision_id,created_at) VALUES (?,?,?,?,1)").run(instanceId, thread.id, thread.projectId, revisionId);
  });
  return { teamId, revisionId, instanceId };
}
