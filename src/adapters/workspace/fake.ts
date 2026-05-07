import { createHash } from "node:crypto";
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
 * In-memory + tmpdir workspace adapter for tests.
 *
 * `prepareInnerWorkspace` creates a directory under `rootDir/<slice_id>`
 * (so application code can pass a real `agentCwd` to runners that read
 * stdin frontmatter) but tracks heads as deterministic synthetic hashes
 * keyed by slice_id + commit count. Files are written to disk so an
 * integration test can inspect them.
 *
 * Determinism: head hashes are derived from slice_id + commit index +
 * sorted file digests, so the same sequence of commits produces identical
 * pins across runs. No call to git is performed.
 */
export interface FakeWorkspaceOptions {
  /**
   * When set, the fake workspace will fail rebases for the given slice ids
   * with `result: "conflict"`. Tests use this to drive the SM_STALE branch.
   */
  rebaseConflictSlices?: ReadonlySet<string>;
}

export class FakeWorkspace implements WorkspacePort {
  private readonly state = new Map<string, { head: string; commits: number }>();
  private readonly rebaseConflictSlices: ReadonlySet<string>;

  constructor(
    private readonly rootDir: string,
    options: FakeWorkspaceOptions = {},
  ) {
    this.rebaseConflictSlices = options.rebaseConflictSlices ?? new Set();
  }

  async prepareInnerWorkspace(input: {
    sliceId: string;
    trunkBaseRevision: string;
  }): Promise<PreparedWorkspace> {
    const dir = resolve(this.rootDir, input.sliceId);
    mkdirSync(dir, { recursive: true });
    const existing = this.state.get(input.sliceId);
    if (existing == null) {
      this.state.set(input.sliceId, {
        head: input.trunkBaseRevision,
        commits: 0,
      });
    }
    return {
      agentCwd: dir,
      headBefore: this.state.get(input.sliceId)!.head,
    };
  }

  async commit(input: CommitInput): Promise<CommitResult> {
    const dir = resolve(this.rootDir, input.sliceId);
    for (const f of input.files) {
      assertSafeRel(f.path);
      const target = resolve(dir, f.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.content, "utf8");
    }
    const cur = this.state.get(input.sliceId);
    if (cur == null)
      throw new Error(
        `commit on un-prepared workspace for slice_id=${input.sliceId}`,
      );
    const next = cur.commits + 1;
    const sortedDigest = input.files
      .map((f) => `${f.path}:${sha(f.content)}`)
      .sort()
      .join("|");
    const head = sha(
      `${cur.head}|${input.sliceId}|${next}|${input.message}|${sortedDigest}`,
    ).slice(0, 40);
    this.state.set(input.sliceId, { head, commits: next });
    return { commit: head };
  }

  async head(sliceId: string): Promise<string> {
    const cur = this.state.get(sliceId);
    if (cur == null)
      throw new Error(`no workspace prepared for slice_id=${sliceId}`);
    return cur.head;
  }

  /** Test-only — directory where files have been materialised. */
  agentCwd(sliceId: string): string {
    return resolve(this.rootDir, sliceId);
  }

  async prepareReadOnlyCheckout(input: {
    sliceId: string;
    revision: string;
  }): Promise<PreparedWorkspace> {
    const dir = resolve(this.rootDir, `${input.sliceId}-readonly`);
    mkdirSync(dir, { recursive: true });
    return { agentCwd: dir, headBefore: input.revision };
  }

  async rebaseOntoTrunk(input: {
    sliceId: string;
    trunkRevision: string;
  }): Promise<RebaseOutcome> {
    if (this.rebaseConflictSlices.has(input.sliceId)) {
      return {
        result: "conflict",
        reason: `fake conflict configured for slice_id=${input.sliceId}`,
      };
    }
    const cur = this.state.get(input.sliceId);
    if (cur == null)
      throw new Error(
        `rebase on un-prepared workspace for slice_id=${input.sliceId}`,
      );
    const next = cur.commits + 1;
    const head = sha(
      `${cur.head}|${input.sliceId}|${next}|rebase-onto|${input.trunkRevision}`,
    ).slice(0, 40);
    this.state.set(input.sliceId, { head, commits: next });
    return { result: "clean", commit: head };
  }
}

function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function assertSafeRel(rel: string): void {
  if (rel.length === 0) throw new Error("file path cannot be empty");
  if (isAbsolute(rel)) throw new Error(`absolute paths forbidden: ${rel}`);
  const norm = normalize(rel);
  if (norm.startsWith("..") || norm.includes(`${"/"}..${"/"}`) || norm === "..")
    throw new Error(`path traversal forbidden: ${rel}`);
  if (norm !== rel && norm !== `./${rel}` && join(".", rel) !== norm) {
    // Allow `./prefix` etc. — but reject anything that resolves outside the
    // workspace root via a normalize-pass test.
    if (norm.startsWith("/")) throw new Error(`unsafe path: ${rel}`);
  }
}
