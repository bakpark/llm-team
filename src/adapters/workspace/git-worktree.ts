import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import type {
  CommitInput,
  CommitResult,
  PreparedWorkspace,
  RebaseOutcome,
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

  async prepareReadOnlyCheckout(input: {
    sliceId: string;
    revision: string;
  }): Promise<PreparedWorkspace> {
    const wt = this.readOnlyPath(input.sliceId);
    if (!(await pathExists(wt))) {
      mkdirSync(dirname(wt), { recursive: true });
      await git(this.cfg.repoRoot, [
        "worktree",
        "add",
        "--detach",
        wt,
        input.revision,
      ]);
    } else {
      await git(wt, ["checkout", "--detach", input.revision]);
    }
    return { agentCwd: wt, headBefore: input.revision };
  }

  async rebaseOntoTrunk(input: {
    sliceId: string;
    trunkRevision: string;
  }): Promise<RebaseOutcome> {
    const wt = this.worktreePath(input.sliceId);
    try {
      await git(wt, ["rebase", input.trunkRevision]);
    } catch (err) {
      try {
        await git(wt, ["rebase", "--abort"]);
      } catch {
        // best-effort
      }
      return {
        result: "conflict",
        reason: (err as Error).message.split("\n")[0] ?? "rebase failed",
      };
    }
    const head = (await git(wt, ["rev-parse", "HEAD"])).stdout.trim();
    return { result: "clean", commit: head };
  }

  async getTrunkHead(): Promise<string> {
    // incident-8: resolve the repo-root HEAD so outer-loop callers can pin
    // sessions / slices to a real git ref instead of a placeholder string.
    return (await git(this.cfg.repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  }

  async verifyRef(ref: string): Promise<boolean> {
    // incident-8: `rev-parse --verify <ref>^{commit}` returns exit 0 only if
    // <ref> resolves to a real commit object. Any non-zero exit (including
    // the "fatal: invalid reference" case that crashed turn-worker) is
    // surfaced as `false` so the caller can refuse to persist the slice.
    //
    // PR #106 review (P1): split invalid-ref (expected, silent false) from
    // fatal failures (git binary missing / permission / disk). Fatal cases
    // still return false so the caller can refuse to persist, but emit a
    // console.warn so the silent failure doesn't mask infra problems in
    // production. Do not throw — caller (caller-dispatch-outer
    // persist_slice_dag_and_promote) treats false as
    // noop_planning_request_changes which is the correct recovery path.
    if (typeof ref !== "string" || ref.length === 0) return false;
    try {
      await git(this.cfg.repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]);
      return true;
    } catch (err) {
      const msg = (err as Error).message ?? "";
      const looksInvalidRef =
        msg.includes("Needed a single revision") ||
        msg.includes("unknown revision") ||
        msg.includes("ambiguous argument") ||
        msg.includes("bad revision") ||
        msg.includes("fatal: Not a valid object name");
      if (!looksInvalidRef) {
        console.warn(
          `git-worktree.verifyRef: non-invalid-ref failure for ref=${ref}: ${msg.split("\n")[0] ?? msg}`,
        );
      }
      return false;
    }
  }

  // ---------- Phase 1 additive surface (cli-spicy-anchor.md §7-2) ----------

  async findCommitByTrailer(input: {
    branch: string;
    trailerKey: string;
    value: string;
    depth?: number;
  }): Promise<string | null> {
    const depth = input.depth ?? 50;
    // `git log -n <depth> --format=%H%x00%B%x00%x01` — split on \x01 then \x00.
    let res: GitResult;
    try {
      res = await git(this.cfg.repoRoot, [
        "log",
        "-n",
        String(depth),
        "--format=%H%x00%B%x01",
        input.branch,
      ]);
    } catch {
      return null;
    }
    const records = res.stdout.split("\x01").filter((s) => s.length > 0);
    const trailerRe = new RegExp(
      `^${escapeRegExp(input.trailerKey)}:\\s*(.+)$`,
      "m",
    );
    for (const rec of records) {
      const idx = rec.indexOf("\x00");
      if (idx < 0) continue;
      const sha = rec.slice(0, idx).trim();
      const body = rec.slice(idx + 1);
      const m = trailerRe.exec(body);
      if (m && m[1]?.trim() === input.value) return sha;
    }
    return null;
  }

  async getRemoteHeadSha(input: {
    remote: string;
    branch: string;
  }): Promise<string | null> {
    try {
      const res = await git(this.cfg.repoRoot, [
        "ls-remote",
        "--heads",
        input.remote,
        input.branch,
      ]);
      const line = res.stdout.split("\n").find((l) => l.length > 0);
      if (line == null) return null;
      const sha = line.split(/\s+/)[0]?.trim();
      return sha && sha.length > 0 ? sha : null;
    } catch {
      return null;
    }
  }

  async push(input: {
    sliceId: string;
    remote: string;
    branch: string;
  }): Promise<void> {
    const wt = this.worktreePath(input.sliceId);
    // PR #119 review P0b (gpt5.5): real network push. `git push` is
    // idempotent on no-op (remote already has the local head); errors
    // propagate so the lead-invoker records `outbox_failed`.
    await git(wt, [
      "push",
      input.remote,
      `${input.branch}:${input.branch}`,
    ]);
  }

  async resetHard(input: { sliceId: string; sha: string }): Promise<void> {
    const wt = this.worktreePath(input.sliceId);
    await git(wt, ["reset", "--hard", input.sha]);
  }

  async cleanForce(input: { sliceId: string }): Promise<void> {
    const wt = this.worktreePath(input.sliceId);
    await git(wt, ["clean", "-fdx"]);
  }

  private worktreePath(sliceId: string): string {
    return resolve(this.cfg.workspacesDir, sliceId);
  }

  private readOnlyPath(sliceId: string): string {
    return resolve(this.cfg.workspacesDir, `${sliceId}-readonly`);
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
