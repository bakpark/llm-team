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
  /**
   * incident-8: deterministic SHA returned by `getTrunkHead()`. Defaults to
   * a 40-char fixture hash so tests can assert pin propagation without
   * shelling out to git.
   */
  trunkHead?: string;
  /**
   * incident-8: refs that `verifyRef()` should accept. By default the fake
   * accepts the configured `trunkHead` (or its default) plus any value
   * supplied to `prepareInnerWorkspace` so existing test fixtures keep
   * working without explicit allowlisting.
   */
  knownRefs?: ReadonlySet<string>;
  /**
   * PR #119 review P0b (gpt5.5): how `push()` mutates the in-memory remote
   * head registry. Default `"seed_remote_head"` mirrors a successful real
   * push: after `push({ sliceId, remote, branch })` the entry at
   * `<remote>/<branch>` becomes the current local head, so the lead-invoker
   * `getRemoteHeadSha` probe matches without explicit `seedRemoteHead`.
   * `"no_op"` keeps the legacy "no-network" behaviour — push is a no-op,
   * `getRemoteHeadSha` still reflects whatever the test seeded — used by the
   * crash-recovery test that needs the probe to mismatch.
   */
  pushBehavior?: "seed_remote_head" | "no_op";
}

const DEFAULT_FAKE_TRUNK_HEAD = "0".repeat(40);

export class FakeWorkspace implements WorkspacePort {
  private readonly state = new Map<string, { head: string; commits: number }>();
  private readonly rebaseConflictSlices: ReadonlySet<string>;
  private readonly trunkHead: string;
  private readonly knownRefs: Set<string>;
  private readonly pushBehavior: "seed_remote_head" | "no_op";

  constructor(
    private readonly rootDir: string,
    options: FakeWorkspaceOptions = {},
  ) {
    this.rebaseConflictSlices = options.rebaseConflictSlices ?? new Set();
    this.trunkHead = options.trunkHead ?? DEFAULT_FAKE_TRUNK_HEAD;
    this.knownRefs = new Set(options.knownRefs ?? []);
    this.knownRefs.add(this.trunkHead);
    this.pushBehavior = options.pushBehavior ?? "seed_remote_head";
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
    // incident-8: any ref the test seeded as the slice base is treated as a
    // known ref so subsequent verifyRef() checks succeed without explicit
    // configuration.
    this.knownRefs.add(input.trunkBaseRevision);
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

  async getTrunkHead(): Promise<string> {
    return this.trunkHead;
  }

  async verifyRef(ref: string): Promise<boolean> {
    if (typeof ref !== "string" || ref.length === 0) return false;
    return this.knownRefs.has(ref);
  }

  // ---------- Phase 1 additive surface (cli-spicy-anchor.md §7-2) ----------

  /** Test-only registry of trailers seeded by the fake or by `commit`. */
  private readonly commitTrailers = new Map<
    string,
    { sha: string; trailers: Map<string, string> }[]
  >();

  /** Test-only registry of remote heads keyed by `<remote>/<branch>`. */
  private readonly remoteHeads = new Map<string, string>();

  /** Counts of resetHard / cleanForce calls (test introspection). */
  resetHardCount = 0;
  cleanForceCount = 0;

  /** Test seeder — appends a fake commit log entry with trailers. */
  seedCommitTrailer(branch: string, sha: string, trailers: Record<string, string>): void {
    const list = this.commitTrailers.get(branch) ?? [];
    list.push({ sha, trailers: new Map(Object.entries(trailers)) });
    this.commitTrailers.set(branch, list);
  }

  /** Test seeder — sets a remote head for `<remote>/<branch>`. */
  seedRemoteHead(remote: string, branch: string, sha: string | null): void {
    if (sha == null) this.remoteHeads.delete(`${remote}/${branch}`);
    else this.remoteHeads.set(`${remote}/${branch}`, sha);
  }

  async findCommitByTrailer(input: {
    branch: string;
    trailerKey: string;
    value: string;
    depth?: number;
  }): Promise<string | null> {
    const list = this.commitTrailers.get(input.branch);
    if (list == null || list.length === 0) return null;
    const depth = input.depth ?? 50;
    const slice = list.slice(-depth).reverse();
    for (const entry of slice) {
      if (entry.trailers.get(input.trailerKey) === input.value) {
        return entry.sha;
      }
    }
    return null;
  }

  async getRemoteHeadSha(input: {
    remote: string;
    branch: string;
  }): Promise<string | null> {
    return this.remoteHeads.get(`${input.remote}/${input.branch}`) ?? null;
  }

  /**
   * PR #119 review P0b (gpt5.5): real-push surface. Default
   * (`pushBehavior=seed_remote_head`) writes the current local head to the
   * remote registry so `getRemoteHeadSha` matches without explicit
   * `seedRemoteHead` calls in the test setup. `no_op` mode preserves the
   * legacy fake behaviour for the crash-recovery test.
   */
  pushCount = 0;
  async push(input: {
    sliceId: string;
    remote: string;
    branch: string;
  }): Promise<void> {
    this.pushCount += 1;
    if (this.pushBehavior === "no_op") return;
    const cur = this.state.get(input.sliceId);
    if (cur == null) {
      throw new Error(
        `push on un-prepared workspace for slice_id=${input.sliceId}`,
      );
    }
    this.remoteHeads.set(`${input.remote}/${input.branch}`, cur.head);
  }

  async resetHard(input: { sliceId: string; sha: string }): Promise<void> {
    this.resetHardCount += 1;
    const cur = this.state.get(input.sliceId);
    if (cur == null)
      throw new Error(
        `resetHard on un-prepared workspace for slice_id=${input.sliceId}`,
      );
    this.state.set(input.sliceId, { head: input.sha, commits: cur.commits });
  }

  async cleanForce(_input: { sliceId: string }): Promise<void> {
    this.cleanForceCount += 1;
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
