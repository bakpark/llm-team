/**
 * Phase 5c — KAC-REFACTOR-BACKLOG 6-state lifecycle.
 *
 * Covers proposal → CURATED → SCHEDULED → DONE happy path; DROPPED + SUPERSEDED
 * branches; idempotency on re-transition; scoutScan dedup by fingerprint;
 * ledger row emission per transition.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FsStore } from "../../src/adapters/store/fs.js";
import { FileLedger } from "../../src/application/ledger.js";
import {
  listRefactorProposals,
  proposeRefactor,
  scoutScan,
  transitionRefactor,
} from "../../src/application/refactor-backlog.js";
import { layout } from "../../src/application/persistence-layout.js";
import { CollectingLogger } from "../../src/ports/logger.js";
import { SystemClock } from "../../src/ports/clock.js";

function setup() {
  const workdir = mkdtempSync(join(tmpdir(), "refactor-backlog-"));
  const store = new FsStore({ workdir });
  const clock = new SystemClock();
  const logger = new CollectingLogger();
  const ledger = new FileLedger({ store, logger });
  return {
    workdir,
    store,
    clock,
    ledger,
    deps: {
      store,
      clock,
      ledger,
      callerId: "caller-1",
      targetId: "demo",
    } as const,
  };
}

describe("refactor-backlog — happy path PROPOSED → CURATED → SCHEDULED → DONE", () => {
  it("walks the lifecycle and emits a ledger row per transition", async () => {
    const env = setup();
    const item = await proposeRefactor(
      {
        proposed_by: "scout",
        scope: "src/x.ts hot path",
        suggested_refactor: "extract helper",
        rationale: "complexity > 20",
        code_location: "src/x.ts",
        metric_target: "complexity_lte_15",
        evidence_refs: [],
      },
      env.deps,
    );
    expect(item.state).toBe("PROPOSED");
    expect(item.proposed_by).toBe("scout");

    const curated = await transitionRefactor(
      { proposal_id: item.proposal_id, to_state: "CURATED" },
      env.deps,
    );
    expect(curated.state).toBe("CURATED");
    expect(curated.audit_hash).not.toBe(item.audit_hash);

    const scheduled = await transitionRefactor(
      {
        proposal_id: item.proposal_id,
        to_state: "SCHEDULED",
        spawning_slice_id: "01HZS0000000000000000000Z9",
      },
      env.deps,
    );
    expect(scheduled.state).toBe("SCHEDULED");
    expect(scheduled.spawning_slice_id).toBe("01HZS0000000000000000000Z9");

    const done = await transitionRefactor(
      { proposal_id: item.proposal_id, to_state: "DONE" },
      env.deps,
    );
    expect(done.state).toBe("DONE");

    // Persisted body parses + audit_hash chains.
    const persisted = await env.store.readText(
      layout.refactorProposal(item.proposal_id),
    );
    expect(persisted).not.toBeNull();
    expect(JSON.parse(persisted!).state).toBe("DONE");
  });
});

describe("refactor-backlog — illegal transitions are rejected", () => {
  it("rejects PROPOSED → SCHEDULED (skip CURATED)", async () => {
    const env = setup();
    const item = await proposeRefactor(
      {
        proposed_by: "forge",
        scope: "src/y.ts",
        suggested_refactor: "split module",
        rationale: "too long",
        code_location: "src/y.ts",
      },
      env.deps,
    );
    await expect(
      transitionRefactor(
        { proposal_id: item.proposal_id, to_state: "SCHEDULED" },
        env.deps,
      ),
    ).rejects.toThrow(/illegal PROPOSED → SCHEDULED/);
  });

  it("rejects DONE → CURATED (terminal state)", async () => {
    const env = setup();
    const item = await proposeRefactor(
      {
        proposed_by: "sentinel",
        scope: "z",
        suggested_refactor: "z",
        rationale: "z",
        code_location: "z",
      },
      env.deps,
    );
    await transitionRefactor(
      { proposal_id: item.proposal_id, to_state: "CURATED" },
      env.deps,
    );
    await transitionRefactor(
      { proposal_id: item.proposal_id, to_state: "SCHEDULED" },
      env.deps,
    );
    await transitionRefactor(
      { proposal_id: item.proposal_id, to_state: "DONE" },
      env.deps,
    );
    await expect(
      transitionRefactor(
        { proposal_id: item.proposal_id, to_state: "CURATED" },
        env.deps,
      ),
    ).rejects.toThrow(/illegal DONE → CURATED/);
  });
});

describe("refactor-backlog — DROPPED and SUPERSEDED branches", () => {
  it("PROPOSED → DROPPED works without spawning_slice_id", async () => {
    const env = setup();
    const item = await proposeRefactor(
      {
        proposed_by: "scout",
        scope: "scope",
        suggested_refactor: "refactor",
        rationale: "rationale",
        code_location: "loc",
      },
      env.deps,
    );
    const dropped = await transitionRefactor(
      { proposal_id: item.proposal_id, to_state: "DROPPED" },
      env.deps,
    );
    expect(dropped.state).toBe("DROPPED");
  });

  it("CURATED → SUPERSEDED records superseded_by", async () => {
    const env = setup();
    const a = await proposeRefactor(
      {
        proposed_by: "scout",
        scope: "a",
        suggested_refactor: "a",
        rationale: "a",
        code_location: "a",
      },
      env.deps,
    );
    const b = await proposeRefactor(
      {
        proposed_by: "scout",
        scope: "b",
        suggested_refactor: "b",
        rationale: "b",
        code_location: "b",
      },
      env.deps,
    );
    await transitionRefactor(
      { proposal_id: a.proposal_id, to_state: "CURATED" },
      env.deps,
    );
    const out = await transitionRefactor(
      {
        proposal_id: a.proposal_id,
        to_state: "SUPERSEDED",
        superseded_by: b.proposal_id,
      },
      env.deps,
    );
    expect(out.state).toBe("SUPERSEDED");
    expect(out.superseded_by).toBe(b.proposal_id);
  });
});

describe("refactor-backlog — idempotent re-transition", () => {
  it("returns the live entry without re-writing when to_state == current state", async () => {
    const env = setup();
    const item = await proposeRefactor(
      {
        proposed_by: "scout",
        scope: "x",
        suggested_refactor: "x",
        rationale: "x",
        code_location: "x",
      },
      env.deps,
    );
    const a = await transitionRefactor(
      { proposal_id: item.proposal_id, to_state: "CURATED" },
      env.deps,
    );
    const b = await transitionRefactor(
      { proposal_id: item.proposal_id, to_state: "CURATED" },
      env.deps,
    );
    expect(a.audit_hash).toBe(b.audit_hash);
    expect(b.state).toBe("CURATED");
  });
});

describe("refactor-backlog — PR #72 P1-1 idempotent re-entry skips ledger emit", () => {
  it("does not append a ledger row on idempotent re-transition", async () => {
    const env = setup();
    const item = await proposeRefactor(
      {
        proposed_by: "scout",
        scope: "x",
        suggested_refactor: "x",
        rationale: "x",
        code_location: "x",
      },
      env.deps,
    );
    await transitionRefactor(
      { proposal_id: item.proposal_id, to_state: "CURATED" },
      env.deps,
    );
    const ledgerBefore = (await env.store.readText("ledger/transitions.ndjson")) ?? "";
    const linesBefore = ledgerBefore.split("\n").filter((l) => l.length > 0).length;

    // Idempotent re-entry — must NOT emit any ledger row.
    await transitionRefactor(
      { proposal_id: item.proposal_id, to_state: "CURATED" },
      env.deps,
    );
    const ledgerAfter = (await env.store.readText("ledger/transitions.ndjson")) ?? "";
    const linesAfter = ledgerAfter.split("\n").filter((l) => l.length > 0).length;
    expect(linesAfter).toBe(linesBefore);
  });
});

describe("refactor-backlog — PR #72 P1-2 SUPERSEDED requires superseded_by", () => {
  it("throws when transitioning to SUPERSEDED without superseded_by", async () => {
    const env = setup();
    const item = await proposeRefactor(
      {
        proposed_by: "scout",
        scope: "x",
        suggested_refactor: "x",
        rationale: "x",
        code_location: "x",
      },
      env.deps,
    );
    await expect(
      transitionRefactor(
        { proposal_id: item.proposal_id, to_state: "SUPERSEDED" },
        env.deps,
      ),
    ).rejects.toThrow(/SUPERSEDED requires superseded_by/);
    await expect(
      transitionRefactor(
        {
          proposal_id: item.proposal_id,
          to_state: "SUPERSEDED",
          superseded_by: null,
        },
        env.deps,
      ),
    ).rejects.toThrow(/SUPERSEDED requires superseded_by/);
  });
});

describe("scoutScan — dedups by (scope, code_location, suggested_refactor) fingerprint", () => {
  it("first scan adds the candidate; second scan skips it as duplicate", async () => {
    const env = setup();
    const candidate = {
      scope: "src/q.ts",
      suggested_refactor: "split into helpers",
      rationale: "complexity",
      code_location: "src/q.ts",
    };
    const r1 = await scoutScan({ scan: async () => [candidate] }, env.deps);
    expect(r1.proposed).toHaveLength(1);
    expect(r1.duplicates).toHaveLength(0);

    const r2 = await scoutScan({ scan: async () => [candidate] }, env.deps);
    expect(r2.proposed).toHaveLength(0);
    expect(r2.duplicates).toHaveLength(1);

    const all = await listRefactorProposals(env.store);
    expect(all).toHaveLength(1);
    expect(all[0]?.proposed_by).toBe("scout");
  });
});

describe("refactor-backlog — listRefactorProposals", () => {
  it("returns all proposals across states", async () => {
    const env = setup();
    const a = await proposeRefactor(
      {
        proposed_by: "scout",
        scope: "a",
        suggested_refactor: "a",
        rationale: "a",
        code_location: "a",
      },
      env.deps,
    );
    await proposeRefactor(
      {
        proposed_by: "forge",
        scope: "b",
        suggested_refactor: "b",
        rationale: "b",
        code_location: "b",
      },
      env.deps,
    );
    await transitionRefactor(
      { proposal_id: a.proposal_id, to_state: "DROPPED" },
      env.deps,
    );
    const all = await listRefactorProposals(env.store);
    expect(all).toHaveLength(2);
    expect(all.map((x) => x.state).sort()).toEqual(["DROPPED", "PROPOSED"]);
  });
});
