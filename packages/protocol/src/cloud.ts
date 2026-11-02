import { z } from "zod";

/** A Vercel team cloud threads can run on. */
export interface CloudTeam {
  id: string;
  name: string;
}

/** What Settings shows about where cloud threads run. Tokens never leave the core. */
export interface CloudStatus {
  /** Null until a Vercel token is saved. */
  vercel: {
    /** Null until a team is chosen. */
    team: CloudTeam | null;
    /** The project on that team the sandboxes belong to. */
    project: string | null;
  } | null;
  /** Whether a Claude token is saved for the agents in the sandboxes. */
  claude: boolean;
  /** Protected storage could not be read. */
  error: string | null;
}

const Token = z.string().trim().min(8).max(1000);

export const cloudRpcParams = {
  "cloud.status": z.object({}),
  /** Checks the token with Vercel and saves it. With one team, that team is chosen too. */
  "cloud.vercel.connect": z.object({ token: Token }).strict(),
  "cloud.vercel.teams": z.object({}),
  /** Chooses the team, and finds or makes the project its sandboxes belong to. */
  "cloud.vercel.team": z.object({ teamId: z.string().min(1).max(200) }).strict(),
  "cloud.vercel.disconnect": z.object({}),
  "cloud.claude.save": z.object({ token: Token }).strict(),
  "cloud.claude.remove": z.object({}),
};

export interface CloudRpcResults {
  "cloud.status": CloudStatus;
  "cloud.vercel.connect": { status: CloudStatus; teams: CloudTeam[] };
  "cloud.vercel.teams": CloudTeam[];
  "cloud.vercel.team": CloudStatus;
  "cloud.vercel.disconnect": CloudStatus;
  "cloud.claude.save": CloudStatus;
  "cloud.claude.remove": CloudStatus;
}
