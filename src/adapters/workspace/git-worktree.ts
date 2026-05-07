import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type {
  CommitInput,
  CommitResult,
  PreparedWorkspace,
  WorkspacePort,
} from "../../ports/workspace.js";

/**
 * Git worktree workspace adapter.
 *
 * Creates a slice-local worktree under `<workdir>/workspaces/<slice_id>` and
 * a slice-local branch `slice/<slice_id>`. Subsequent commits are appended
 * to that branch. Trunk push and rebase are out of scope (phase 3).
 *
 * The adapter shells out to `git`. All operations run inside the slice
 * worktree's cwd. The repository root (where `.git` lives) is configured at
 * construction.
 */

export interface GitWorktreeAdapterCfg {
  /** Path to the repository root (the directory whose `.git` worktrees are reused). */
  repoRoot: string;
  /** Directory under which slice worktrees are created. */
  workspacesDir: string;
  /** Branch prefix. Default `slice/`. */
  branchPrefix?: string;
  /** Author identity used for commits. */
  authorName?: string;
  authorEmail?: string;
}

export class GitWorktreeWorkspace implements WorkspacePort {
  constructor(private readonly cfg: GitWorktreeAdapterCfg) {}

  async prepareInnerWorkspace(input: {
    sliceId: string;
    trunkBaseRevision: string;
  }): Promise<PreparedWorkspace> {
    const wt = this.worktreePath(input.sliceId);
    const branch = this.branchName(input.sliceId);
    if (!(await pathExists(wt))) {
      mkdirSync(dirname(wt), { recursive: true });
      await git(this.cfg.repoRoot, [
        "worktree",
        "add",
        "-b",
        branch,
        wt,
        input.trunkBaseRevision,
      ]);
    }
    const headBefore = (
      await git(wt, ["rev-parse", "HEAD"])
    ).stdout.trim();
    return { agentCwd: wt, headBefore };
  }

  async commit(input: CommitInput): Promise<CommitResult> {
    const wt = this.worktreePath(input.sliceId);
    // P0 fix (PR #61 review): only add the explicit envelope-listed paths.
    // `git add --all` would commit any side-effect file the agent process
    // wrote outside `envelope.artifacts.files`, breaking Inv #4 (Caller-only
    // operational write) and the AGC-OUTPUT envelope strict boundary.
    for (const f of input.files) {
      assertSafeRel(f.path);
      const target = resolve(wt, f.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.content, "utf8");
    }
    if (input.files.length === 0) {
      // No declared artefacts → nothing to commit. Caller decides whether
      // this is a malformed envelope or a legitimate refactor-no-op.
      const head = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
      return { commit: head };
    }
    const addArgs = ["add", "--", ...input.files.map((f) => f.path)];
    await git(wt, addArgs);
    const env = this.commitEnv();
    await git(wt, ["commit", "-m", input.message], env);
    const head = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
    return { commit: head };
  }

  async head(sliceId: string): Promise<string> {
    const wt = this.worktreePath(sliceId);
    return (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
  }

  private worktreePath(sliceId: string): string {
    return resolve(this.cfg.workspacesDir, sliceId);
  }

  private branchName(sliceId: string): string {
    return `${this.cfg.branchPrefix ?? "slice/"}${sliceId}`;
  }

  private commitEnv(): NodeJS.ProcessEnv {
    const e: NodeJS.ProcessEnv = {};
    if (this.cfg.authorName) {
      e.GIT_AUTHOR_NAME = this.cfg.authorName;
      e.GIT_COMMITTER_NAME = this.cfg.authorName;
    }
    if (this.cfg.authorEmail) {
      e.GIT_AUTHOR_EMAIL = this.cfg.authorEmail;
      e.GIT_COMMITTER_EMAIL = this.cfg.authorEmail;
    }
    return e;
  }
}

interface GitResult {
  stdout: string;
  stderr: string;
}

function git(
  cwd: string,
  args: readonly string[],
  extraEnv?: NodeJS.ProcessEnv,
): Promise<GitResult> {
  return new Promise((resolveP, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, ...(extraEnv ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => (stdout += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolveP({ stdout, stderr });
      else
        reject(
          new Error(
            `git ${args.join(" ")} exited code=${code} signal=${signal}\nstderr: ${stderr}`,
          ),
        );
    });
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    const fs = await import("node:fs/promises");
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function assertSafeRel(rel: string): void {
  if (rel.length === 0) throw new Error("file path cannot be empty");
  if (isAbsolute(rel)) throw new Error(`absolute paths forbidden: ${rel}`);
  const norm = normalize(rel);
  if (norm.startsWith("..") || norm.includes(`${"/"}..${"/"}`) || norm === "..")
    throw new Error(`path traversal forbidden: ${rel}`);
  if (norm !== rel && join(".", rel) !== norm) {
    if (norm.startsWith("/")) throw new Error(`unsafe path: ${rel}`);
  }
}
