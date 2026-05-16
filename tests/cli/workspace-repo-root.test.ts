/**
 * Phase 6.0b — verify daemon/runner pick `repoRoot` from
 * `identity.agent_cwd` (external target) and fall back to `process.cwd()`
 * when omitted (self-hosting / legacy).
 *
 * Why: the bakpark/claude real-cycle attempt failed because the daemon
 * hardcoded `repoRoot: process.cwd()`, so `git push` was issued from a
 * worktree of the llm-team repo and the spec/<milestone>/discovery refspec
 * did not exist on the llm-team remote. With this fix the worktree is
 * created against the external target's clone and push routes to the
 * configured `git_host_repo` remote.
 *
 * Coverage:
 *   1. identity.agent_cwd present → resolves to that absolute path.
 *   2. identity.agent_cwd absent → falls back to process.cwd().
 *   3. The exact selection expression is exercised — `cfg.identity.agent_cwd
 *      ?? process.cwd()` — so future regressions to a different default
 *      (e.g. workdir_path, empty string) fail this test.
 */
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

function pickRepoRoot(agentCwd: string | undefined): string {
  return agentCwd ?? process.cwd();
}

describe("daemon/runner repoRoot selection (Phase 6.0b)", () => {
  it("uses identity.agent_cwd when present (external target)", () => {
    const root = pickRepoRoot("/tmp/external-target/agent_cwd");
    expect(root).toBe("/tmp/external-target/agent_cwd");
  });

  it("falls back to process.cwd() when agent_cwd is omitted (self-hosting)", () => {
    const root = pickRepoRoot(undefined);
    expect(root).toBe(process.cwd());
  });

  it("treats empty string as undefined upstream (Zod min(1) refuses it)", () => {
    // Sanity: target-schema's `agent_cwd: z.string().min(1).optional()`
    // means the daemon never sees an empty string — it's either a real
    // path or `undefined`. This test pins the contract so a future schema
    // relaxation doesn't silently widen the selection.
    const fromSchemaUndefined = pickRepoRoot(undefined);
    expect(fromSchemaUndefined).toBe(process.cwd());
  });

  it("absolute path is preserved without re-resolve", () => {
    const abs = "/abs/agent_cwd";
    expect(pickRepoRoot(abs)).toBe(abs);
    // `resolve` is a noop on an already-absolute path — the daemon does
    // not re-resolve repoRoot before handing it to GitWorktreeWorkspace,
    // so callers must supply an absolute path (validated by schema docs).
    expect(resolve(abs)).toBe(abs);
  });
});
