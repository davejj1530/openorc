import { createHash } from "node:crypto";
import { access, mkdir, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProjectIconCandidate, ProjectIconChoice, ProjectIconState } from "../shared/project-icons";
import type { IconPreview } from "./project-icon-images";
import { containedFile, discoverProjectIcons, readSmallFile } from "./project-icon-discovery";
import { isProjectStackIconId } from "../shared/project-stack-icons";
import { detectProjectStack } from "./project-stack";

interface CachedIcons extends ProjectIconState {
  version: 1 | 2 | 3;
  rootPath: string;
}
type RankedIcon = ProjectIconCandidate & { score: number };
const emptyState = (): ProjectIconState => ({ mode: "auto", selected: null, candidates: [], fallback: null });

function validCandidate(value: unknown): value is ProjectIconCandidate {
  if (!value || typeof value !== "object") return false;
  const candidate = value as ProjectIconCandidate;
  return (
    typeof candidate.path === "string" &&
    candidate.path.length <= 4096 &&
    typeof candidate.dataUrl === "string" &&
    candidate.dataUrl.length <= 24 * 1024 &&
    /^data:image\/(png|svg\+xml);base64,/.test(candidate.dataUrl)
  );
}

function validCache(value: unknown, rootPath: string): value is CachedIcons {
  if (!value || typeof value !== "object") return false;
  const cache = value as CachedIcons;
  return (
    [1, 2, 3].includes(cache.version) &&
    (cache.version !== 3 || cache.fallback === null || isProjectStackIconId(cache.fallback)) &&
    cache.rootPath === rootPath &&
    ["auto", "manual", "folder"].includes(cache.mode) &&
    (cache.selected === null || validCandidate(cache.selected)) &&
    Array.isArray(cache.candidates) &&
    cache.candidates.length <= 6 &&
    cache.candidates.every(validCandidate)
  );
}

/** One serial background queue for image decoding across all windows and projects.
 * In-memory promises coalesce reads; disk records cache both hits and misses across restarts.
 */
export class ProjectIcons {
  private readonly reads = new Map<string, Promise<ProjectIconState>>();
  private readonly states = new Map<string, ProjectIconState>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly preview: (file: string) => Promise<IconPreview>,
    private readonly detectStack = detectProjectStack,
  ) {}

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private file(root: string): string {
    return path.join(this.directory, `${createHash("sha256").update(root).digest("hex")}.json`);
  }

  private async save(root: string, state: ProjectIconState): Promise<ProjectIconState> {
    await mkdir(this.directory, { recursive: true });
    const file = this.file(root);
    await writeFile(`${file}.tmp`, JSON.stringify({ ...state, version: 3, rootPath: root }));
    await rename(`${file}.tmp`, file);
    this.states.set(root, state);
    return state;
  }

  private async cached(root: string): Promise<ProjectIconState | null> {
    try {
      const cache: unknown = JSON.parse((await readSmallFile(this.file(root), 200 * 1024)).toString("utf8"));
      if (!validCache(cache, root)) return null;
      // Older automatic results skipped ICOs on macOS. Recompute once, keeping explicit choices.
      if (cache.version === 1 && cache.mode === "auto") return null;
      // One source check on the first read after launch. Manual thumbnails are durable.
      if (cache.mode === "auto" && cache.selected) await access(path.resolve(root, cache.selected.path));
      let fallback = cache.version === 3 ? cache.fallback : null;
      if (cache.version !== 3 && cache.mode === "auto") fallback = await this.detectStack(root);
      const state = { mode: cache.mode, selected: cache.selected, candidates: cache.candidates, fallback };
      if (cache.version !== 3) return this.save(root, state);
      this.states.set(root, state);
      return state;
    } catch {
      return null;
    }
  }

  get(root: string): Promise<ProjectIconState> {
    const pending = this.reads.get(root);
    if (pending) return pending;
    return this.remember(
      root,
      this.enqueue(async () => (await this.cached(root)) ?? this.scan(root, emptyState())),
    );
  }

  private remember(root: string, result: Promise<ProjectIconState>): Promise<ProjectIconState> {
    this.reads.set(root, result);
    void result.catch(() => {
      if (this.reads.get(root) === result) this.reads.delete(root);
    });
    return result;
  }

  private async candidates(root: string): Promise<RankedIcon[]> {
    const canonicalRoot = await realpath(root);
    const discovered = await discoverProjectIcons(canonicalRoot);
    const candidates: RankedIcon[] = [];
    // Decode only the highest-ranked twelve files, sequentially. Keep at most six distinct previews.
    for (const candidate of discovered.slice(0, 12)) {
      try {
        const file = await containedFile(canonicalRoot, path.join(canonicalRoot, candidate.path));
        const preview = await this.preview(file);
        candidates.push({ path: candidate.path, dataUrl: preview.dataUrl, score: candidate.score + (preview.square ? 10 : -25) });
      } catch {
        // Corrupt, oversized and unsupported images simply leave the folder fallback.
      }
    }
    const seen = new Set<string>();
    return candidates
      .sort((a, b) => b.score - a.score)
      .filter((candidate) => {
        if (seen.has(candidate.dataUrl)) return false;
        seen.add(candidate.dataUrl);
        return true;
      })
      .slice(0, 6);
  }

  private async scan(root: string, previous: ProjectIconState): Promise<ProjectIconState> {
    const ranked = await this.candidates(root);
    const candidates = ranked.map(({ path, dataUrl }) => ({ path, dataUrl }));
    let selected = previous.selected;
    if (previous.mode === "auto") {
      const first = ranked[0];
      const second = ranked[1];
      const confident = first && first.score >= 90 && (!second || first.score - second.score >= 10);
      selected = confident ? candidates[0]! : null;
    }
    const fallback = await this.detectStack(root);
    return this.save(root, { mode: previous.mode, selected, candidates, fallback });
  }

  async refresh(root: string): Promise<ProjectIconState> {
    await this.get(root);
    return this.remember(
      root,
      this.enqueue(() => this.scan(root, this.states.get(root)!)),
    );
  }

  async choose(root: string, choice: ProjectIconChoice): Promise<ProjectIconState> {
    await this.get(root);
    return this.remember(
      root,
      this.enqueue(async () => {
        const previous = this.states.get(root)!;
        if (choice.mode === "auto") return this.scan(root, emptyState());
        if (choice.mode === "folder") return this.save(root, { ...previous, mode: "folder", selected: null });
        const selected = previous.candidates.find((candidate) => candidate.path === choice.path);
        if (!selected) throw new Error("That icon is no longer available. Refresh the candidates.");
        return this.save(root, { ...previous, mode: "manual", selected });
      }),
    );
  }

  async pick(root: string, file: string): Promise<ProjectIconState> {
    await this.get(root);
    return this.remember(
      root,
      this.enqueue(async () => {
        const previous = this.states.get(root)!;
        const preview = await this.preview(file);
        return this.save(root, { ...previous, mode: "manual", selected: { path: file, dataUrl: preview.dataUrl } });
      }),
    );
  }
}
