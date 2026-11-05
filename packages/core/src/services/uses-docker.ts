import { git } from "@openorc/git";

/** One sign that a project runs Docker as it works: a file by name, and a line in it that says so. */
interface DockerSign {
  /** File names, as globs within one folder, in any case. */
  files: string[];
  /** An extended regular expression, matched in any case; "." when having the file says it. */
  says: string;
}

/**
 * What tells that a project runs Docker, so its cloud sandbox must too. A lone Dockerfile does not: it builds an image
 * to deploy, and on Agent37 would put the project on a VM billed at 2.5 times the default for nothing.
 */
const SIGNS: DockerSign[] = [
  { files: ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"], says: "." },
  {
    files: ["package.json", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "pyproject.toml", "requirements*.txt", "Gemfile", "Cargo.toml", "composer.json", "mix.exs"],
    says: "testcontainers",
  },
  {
    files: ["package.json", "Makefile", "GNUmakefile", "justfile", "Taskfile.yml", "Taskfile.yaml"],
    says: "(^|[^[:alnum:]_-])docker(-compose|[[:space:]]+(compose|run))([^[:alnum:]_-]|$)",
  },
];

/** How many folders down a sign counts: a monorepo's packages, not every copy of a dependency kept in the repository. */
const DEPTH = 3;

const pathspecs = (files: string[]) => files.flatMap((file) => Array.from({ length: DEPTH + 1 }, (_, depth) => `:(glob,icase)${"*/".repeat(depth)}${file}`));

/**
 * Whether the project in `folder` runs Docker, read from its tracked files: the worktree's own, or those of `commit`
 * when given, as before a new worktree exists.
 */
export async function usesDocker(folder: string, commit?: string): Promise<boolean> {
  for (const sign of SIGNS) {
    const args = ["grep", "-q", "-I", "-i", "-E", "-e", sign.says, ...(commit ? [commit] : []), "--", ...pathspecs(sign.files), ":(exclude,glob)**/node_modules/**"];
    if ((await git(folder, args, { okCodes: [0, 1] })).code === 0) return true;
  }
  return false;
}
